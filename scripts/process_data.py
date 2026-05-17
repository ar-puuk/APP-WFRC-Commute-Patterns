# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "pyarrow>=14.0",
#   "geopandas>=0.14",
#   "requests>=2.31",
#   "shapely>=2.0",
# ]
# ///
"""
WFRC Commute Patterns — Offline Data Pipeline

Downloads LEHD LODES8 OD data for Utah, joins with the LEHD crosswalk to
get city/county names, filters to the WFRC 9-county region, aggregates to
city->city and county->county flow pairs, computes geographic centroids from
Census TIGER shapefiles, and exports Parquet + JSON files to ../data/.

Run once locally before committing data files:
    uv run scripts/process_data.py
"""

import sys
import json
from pathlib import Path
import pandas as pd
import geopandas as gpd
import pyarrow as pa
import pyarrow.parquet as pq

# ── Output directory ─────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# ── WFRC 9-county FIPS codes ──────────────────────────────────────────────────
WFRC_COUNTIES = {
    "49003": "Box Elder County",
    "49011": "Davis County",
    "49057": "Weber County",
    "49029": "Morgan County",
    "49035": "Salt Lake County",
    "49049": "Utah County",
    "49045": "Tooele County",
    "49051": "Wasatch County",
    "49043": "Summit County",
}

# ── LEHD LODES8 URLs (Utah, 2022; fall back to 2021 if unavailable) ──────────
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8/ut"
OD_YEARS = ["2022", "2021"]
OD_TEMPLATE = LODES_BASE + "/od/ut_od_main_JT00_{year}.csv.gz"
XWALK_URL = LODES_BASE + "/ut_xwalk.csv.gz"

# ── Census TIGER 2020 URLs (Utah state FIPS = 49) ────────────────────────────
TIGER_BASE = "https://www2.census.gov/geo/tiger/TIGER2020"
PLACES_URL = f"{TIGER_BASE}/PLACE/tl_2020_49_place.zip"
COUNTIES_URL = f"{TIGER_BASE}/COUNTY/tl_2020_us_county.zip"  # counties file is national

# ── LEHD OD columns to aggregate ─────────────────────────────────────────────
AGG_COLS = ["S000", "SA01", "SA02", "SA03", "SE01", "SE02", "SE03", "SI01", "SI02", "SI03"]


def load_od(years=OD_YEARS):
    """Download OD CSV.GZ, trying each year until one succeeds."""
    for year in years:
        url = OD_TEMPLATE.format(year=year)
        print(f"  Trying OD data for {year}: {url}")
        try:
            df = pd.read_csv(
                url,
                dtype={"w_geocode": str, "h_geocode": str},
                usecols=["w_geocode", "h_geocode"] + AGG_COLS,
            )
            print(f"  Loaded {len(df):,} OD records for {year}")
            return df, year
        except Exception as e:
            print(f"  Failed ({e}), trying next year...")
    sys.exit("ERROR: Could not download OD data for any year.")


def load_xwalk():
    """Download and slim the LEHD geographic crosswalk."""
    print(f"  Downloading crosswalk: {XWALK_URL}")
    xw = pd.read_csv(
        XWALK_URL,
        dtype={"tabblk2020": str, "stplc": str, "cty": str},
        usecols=["tabblk2020", "stplc", "stplcname", "cty", "ctyname"],
    )
    # County FIPS is 5 chars (state+county); place FIPS is 7 chars (state+place)
    xw["cty"] = xw["cty"].str.zfill(5)
    xw["stplc"] = xw["stplc"].str.zfill(7)
    print(f"  Crosswalk rows: {len(xw):,}")
    return xw


def build_lookup(xw):
    """Return a dict: block_fips -> {city_name, county_name, county_fips, place_fips}"""
    lookup = {}
    for row in xw.itertuples(index=False):
        # Unincorporated blocks have no place; use county label
        city = row.stplcname if pd.notna(row.stplcname) and row.stplcname else None
        if city:
            city = _clean_stplcname(city)
        # Use canonical WFRC county name (e.g. "Salt Lake County") if available,
        # otherwise fall back to the raw xwalk ctyname (e.g. "Salt Lake County, UT")
        raw_county = row.ctyname if pd.notna(row.ctyname) else None
        county = WFRC_COUNTIES.get(row.cty, raw_county)
        lookup[row.tabblk2020] = {
            "city_name": city,
            "county_name": county,
            "county_fips": row.cty,
            "place_fips": row.stplc,
        }
    return lookup


def join_od_with_lookup(od, lookup):
    """Add home/work city & county columns to OD dataframe."""
    def get(col):
        def fn(geocode):
            info = lookup.get(geocode, {})
            return info.get(col)
        return fn

    print("  Joining OD with crosswalk...")
    od["h_city"]     = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("city_name"))
    od["h_county"]   = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("county_name"))
    od["h_cty"]      = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("county_fips"))
    od["h_plc"]      = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("place_fips"))

    od["w_city"]     = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("city_name"))
    od["w_county"]   = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("county_name"))
    od["w_cty"]      = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("county_fips"))

    return od


def filter_wfrc(od):
    """Keep only rows where BOTH home and work blocks are in WFRC counties."""
    mask = od["h_cty"].isin(WFRC_COUNTIES) & od["w_cty"].isin(WFRC_COUNTIES)
    filtered = od[mask].copy()
    print(f"  WFRC OD rows: {len(filtered):,} (of {len(od):,})")
    return filtered


def fill_unincorporated(od):
    """Blocks with no place name get '[County] Unincorporated' as city label."""
    h_mask = od["h_city"].isna()
    od.loc[h_mask, "h_city"] = od.loc[h_mask, "h_county"].apply(
        lambda c: f"{c} Unincorporated" if pd.notna(c) else "Unincorporated"
    )
    w_mask = od["w_city"].isna()
    od.loc[w_mask, "w_city"] = od.loc[w_mask, "w_county"].apply(
        lambda c: f"{c} Unincorporated" if pd.notna(c) else "Unincorporated"
    )
    return od


def aggregate_city_flows(od):
    grouped = (
        od.groupby(["h_city", "w_city", "h_county", "w_county"])[AGG_COLS]
        .sum()
        .reset_index()
    )
    grouped.columns = ["home_name", "work_name", "home_county", "work_county"] + AGG_COLS
    grouped = grouped[grouped["S000"] > 0]
    print(f"  City flow pairs: {len(grouped):,}")
    return grouped


def aggregate_county_flows(od):
    grouped = (
        od.groupby(["h_county", "w_county"])[AGG_COLS]
        .sum()
        .reset_index()
    )
    grouped.columns = ["home_county", "work_county"] + AGG_COLS
    grouped = grouped[grouped["S000"] > 0]
    print(f"  County flow pairs: {len(grouped):,}")
    return grouped


def load_tiger_places():
    print(f"  Downloading TIGER places: {PLACES_URL}")
    places = gpd.read_file(PLACES_URL)
    # Project to Utah State Plane (meters) for accurate centroid, then back to WGS84
    centroids = places.to_crs(epsg=26912).geometry.centroid
    centroids_wgs = centroids.to_crs(epsg=4326)
    places = places.to_crs(epsg=4326)
    places["lat"] = centroids_wgs.y
    places["lon"] = centroids_wgs.x
    # Build a 7-char full FIPS (state + place) to match xwalk stplc format
    places["FULL_PLACEFP"] = places["STATEFP"] + places["PLACEFP"]
    return places


def load_tiger_counties():
    print(f"  Downloading TIGER counties: {COUNTIES_URL}")
    counties = gpd.read_file(COUNTIES_URL)
    # Filter to Utah (STATEFP = 49) before computing centroids
    counties = counties[counties["STATEFP"] == "49"].copy()
    centroids = counties.to_crs(epsg=26912).geometry.centroid
    centroids_wgs = centroids.to_crs(epsg=4326)
    counties = counties.to_crs(epsg=4326)
    counties["lat"] = centroids_wgs.y
    counties["lon"] = centroids_wgs.x
    counties["COUNTYFP_full"] = counties["STATEFP"] + counties["COUNTYFP"]
    return counties


def _clean_stplcname(s):
    """'Salt Lake City city, Utah' -> 'Salt Lake City'"""
    if not pd.notna(s) or not s:
        return s
    s = s.split(",")[0].strip()  # drop ', Utah'
    parts = s.rsplit(" ", 1)
    if len(parts) == 2 and parts[1].lower() in (
        "city", "town", "village", "borough", "cdp", "township", "municipality"
    ):
        return parts[0].strip()
    return s


def build_city_meta(city_flows, xw, places):
    """Build city metadata: name, county, county_fips, lat, lon, place_fips."""
    city_county_pairs = set(
        zip(city_flows["home_name"], city_flows["home_county"])
    ) | set(
        zip(city_flows["work_name"], city_flows["work_county"])
    )

    # Build name → full 7-char place FIPS using the SAME cleaning logic as build_lookup
    # xwalk stplc is already 7 chars (state+place); TIGER FULL_PLACEFP matches this
    xw_clean = xw[xw["stplcname"].notna() & xw["stplc"].notna()].copy()
    xw_clean["clean_name"] = xw_clean["stplcname"].apply(_clean_stplcname)
    name_to_plc = (
        xw_clean.drop_duplicates("clean_name")
        .set_index("clean_name")["stplc"]
        .to_dict()
    )

    cty_name_to_fips = {v: k for k, v in WFRC_COUNTIES.items()}
    places_idx = places.set_index("FULL_PLACEFP")

    meta = []
    unmatched = []

    for city_name, county_name in sorted(city_county_pairs):
        place_fips = name_to_plc.get(city_name)
        lat, lon = None, None

        if place_fips and place_fips in places_idx.index:
            row = places_idx.loc[place_fips]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            lat = float(row["lat"])
            lon = float(row["lon"])
        else:
            unmatched.append(city_name)

        county_fips = cty_name_to_fips.get(county_name, "")

        meta.append({
            "name": city_name,
            "county": county_name,
            "county_fips": county_fips,
            "lat": lat,
            "lon": lon,
            "place_fips": place_fips or "",
        })

    if unmatched:
        print(f"  WARNING: {len(unmatched)} cities without centroid (likely unincorporated areas): {sorted(set(unmatched))[:10]}")

    return meta


def build_county_meta(counties):
    """Build county metadata for the 9 WFRC counties."""
    counties_idx = counties.set_index("COUNTYFP_full")
    meta = []
    for fips, name in WFRC_COUNTIES.items():
        if fips in counties_idx.index:
            row = counties_idx.loc[fips]
            # loc returns a Series for a single match, DataFrame for multiple
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            meta.append({
                "name": name,
                "county_fips": fips,
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
            })
        else:
            print(f"  WARNING: County FIPS {fips} ({name}) not found in TIGER")
    return meta


def export_parquet(df, path, int_cols):
    """Write DataFrame to Parquet with Snappy compression."""
    for col in int_cols:
        if col in df.columns:
            df[col] = df[col].fillna(0).astype("int32")
    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, path, compression="snappy")
    size_kb = Path(path).stat().st_size / 1024
    print(f"  Wrote {path.name} ({len(df):,} rows, {size_kb:.1f} KB)")


def main():
    print("=== WFRC Commute Patterns Data Pipeline ===\n")

    # 1. Load OD data
    print("1. Loading LEHD OD data...")
    od, year = load_od()

    # 2. Load crosswalk
    print("\n2. Loading LEHD crosswalk...")
    xw = load_xwalk()

    # 3. Build block-level lookup
    print("\n3. Building block -> city/county lookup...")
    lookup = build_lookup(xw)
    print(f"  Lookup entries: {len(lookup):,}")

    # 4. Join OD with lookup
    print("\n4. Joining OD with crosswalk...")
    od = join_od_with_lookup(od, lookup)

    # 5. Filter to WFRC region
    print("\n5. Filtering to WFRC 9-county region...")
    od_wfrc = filter_wfrc(od)

    # 6. Fill unincorporated areas
    print("\n6. Filling unincorporated area names...")
    od_wfrc = fill_unincorporated(od_wfrc)

    # 7. Aggregate
    print("\n7. Aggregating flows...")
    city_flows = aggregate_city_flows(od_wfrc)
    county_flows = aggregate_county_flows(od_wfrc)

    # 8. Load TIGER shapefiles
    print("\n8. Loading TIGER shapefiles for centroids...")
    places = load_tiger_places()
    counties = load_tiger_counties()

    # 9. Build metadata
    print("\n9. Building city and county metadata...")
    city_meta = build_city_meta(city_flows, xw, places)
    county_meta = build_county_meta(counties)
    print(f"  City metadata entries: {len(city_meta)}")
    print(f"  County metadata entries: {len(county_meta)}")

    # 10. Export Parquet files
    print("\n10. Exporting data files...")
    export_parquet(city_flows, DATA_DIR / "city_flows.parquet", AGG_COLS)
    export_parquet(county_flows, DATA_DIR / "county_flows.parquet", AGG_COLS)

    # 11. Export JSON metadata
    with open(DATA_DIR / "city_meta.json", "w") as f:
        json.dump(city_meta, f, indent=2)
    print(f"  Wrote city_meta.json ({len(city_meta)} entries)")

    with open(DATA_DIR / "county_meta.json", "w") as f:
        json.dump(county_meta, f, indent=2)
    print(f"  Wrote county_meta.json ({len(county_meta)} entries)")

    print(f"\n=== Done! Data year: {year}. Files in {DATA_DIR} ===")


if __name__ == "__main__":
    main()
