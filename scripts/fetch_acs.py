# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "requests>=2.31",
# ]
# ///
"""
ACS 5-year commute data fetcher.

Downloads Means of Transportation (B08301/B08601) and Travel Time to Work
(B08303/B08603) from the Census ACS 5-year API for all Utah places and
all Utah counties.

Output per year:
  data/acs/{year}/acs_city.json    — keyed by 7-digit place FIPS ("4967000")
  data/acs/{year}/acs_county.json  — keyed by 5-digit county FIPS ("49035")

ACS 5-year is available from 2009 onward; earlier years produce no output and
the app shows blank/NA charts for those.

Residence geography (B083xx): commute characteristics of workers who LIVE in
  each place/county.
Workplace geography (B086xx): commute characteristics of workers who WORK in
  each place/county. Not all places have sufficient sample; those return null.
"""

import json
import os
import time
import requests
from pathlib import Path

ACS_START_YEAR = 2009
ACS_BASE = "https://api.census.gov/data"
STATE = "49"  # Utah FIPS

# Load Census API key from .env in the project root (two levels up from scripts/)
_ENV_FILE = Path(__file__).parent.parent / ".env"
_CENSUS_KEY = None
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text().splitlines():
        if "CENSUS_API_KEY" in line:
            _CENSUS_KEY = line.split("=", 1)[1].strip().strip("'\"")
            break
if not _CENSUS_KEY:
    _CENSUS_KEY = os.environ.get("CENSUS_API_KEY")


# Residence transportation + travel time (B08301 + B08303)
RES_VARS = [
    "B08301_001E", "B08301_003E", "B08301_004E", "B08301_010E",
    "B08301_018E", "B08301_019E", "B08301_020E", "B08301_021E",
] + [f"B08303_{i:03d}E" for i in range(1, 14)]

# Workplace transportation + travel time (B08601 + B08603)
WRK_VARS = [
    "B08601_001E", "B08601_003E", "B08601_004E", "B08601_010E",
    "B08601_018E", "B08601_019E", "B08601_020E", "B08601_021E",
] + [f"B08603_{i:03d}E" for i in range(1, 14)]


def _safe_int(val):
    """Return None for suppressed (negative) or non-integer Census values."""
    try:
        v = int(val)
        return None if v < 0 else v
    except (TypeError, ValueError):
        return None


def _parse_trans(row, headers, prefix):
    """Parse means-of-transportation variables into a mode dict."""
    def g(s):
        try:
            return _safe_int(row[headers.index(f"{prefix}_{s}")])
        except ValueError:
            return None

    total = g("001E")
    if not total:
        return None
    return {
        "total":   total,
        "drove":   g("003E"),
        "carpool": g("004E"),
        "transit": g("010E"),
        "bike":    g("018E"),
        "walk":    g("019E"),
        "other":   g("020E"),
        "wfh":     g("021E"),
    }


def _parse_time(row, headers, prefix):
    """Parse travel-time variables into grouped buckets."""
    def g(n):
        try:
            return _safe_int(row[headers.index(f"{prefix}_{n:03d}E")])
        except ValueError:
            return None

    total = g(1)
    if not total:
        return None

    def add(*vals):
        parts = [v for v in vals if v is not None]
        return sum(parts) if parts else None

    return {
        "total":   total,
        "lt10":    add(g(2), g(3)),           # <5 + 5–9 min
        "t10_19":  add(g(4), g(5)),           # 10–14 + 15–19
        "t20_29":  add(g(6), g(7)),           # 20–24 + 25–29
        "t30_44":  add(g(8), g(9), g(10)),    # 30–34 + 35–39 + 40–44
        "t45_59":  g(11),                     # 45–59
        "t60plus": add(g(12), g(13)),         # 60–89 + 90+
    }


def _fetch(year, variables, geo_for, geo_in=None):
    """Call Census ACS API. Returns (headers, rows) or (None, None) on failure."""
    url = f"{ACS_BASE}/{year}/acs/acs5"
    params = {"get": ",".join(variables), "for": geo_for}
    if geo_in:
        params["in"] = geo_in
    if _CENSUS_KEY:
        params["key"] = _CENSUS_KEY

    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=60, allow_redirects=False)
            if r.status_code in (204, 302, 400, 404):
                return None, None
            r.raise_for_status()
            data = r.json()
            return (data[0], data[1:]) if len(data) >= 2 else (None, None)
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                print(f"    ACS fetch failed ({geo_for}, {year}): {e}")
                return None, None


def _build_geo_data(year, geo_for, geo_in, fips_col, fips_prefix, filter_set=None):
    """Fetch and merge residence + workplace ACS data for a geography level.

    Returns: {full_fips: {"res": {...}, "wrk": {...} or None}}
    """
    pad = 5 if fips_col == "place" else 3

    # ── Residence data (always fetched) ──────────────────────────────────────
    rh, rr = _fetch(year, RES_VARS, geo_for, geo_in)
    if not rh or not rr:
        return {}
    try:
        fi = rh.index(fips_col)
    except ValueError:
        return {}

    res_map = {}
    for row in rr:
        code = row[fi].zfill(pad)
        if filter_set and code not in filter_set:
            continue
        res_map[code] = row

    time.sleep(0.25)

    # ── Workplace data (graceful failure → wrk stays None) ───────────────────
    wrk_map = {}
    wh, wr = _fetch(year, WRK_VARS, geo_for, geo_in)
    if wh and wr:
        try:
            wfi = wh.index(fips_col)
            for row in wr:
                code = row[wfi].zfill(pad)
                if filter_set and code not in filter_set:
                    continue
                wrk_map[code] = row
        except ValueError:
            pass

    # ── Merge ─────────────────────────────────────────────────────────────────
    out = {}
    for code, rrow in res_map.items():
        rt    = _parse_trans(rrow, rh, "B08301")
        rtime = _parse_time(rrow, rh, "B08303")
        res = {"trans": rt, "time": rtime} if (rt or rtime) else None
        if res is None:
            continue

        wrk = None
        if code in wrk_map:
            wrow  = wrk_map[code]
            wt    = _parse_trans(wrow, wh, "B08601")
            wtime = _parse_time(wrow, wh, "B08603")
            if wt or wtime:
                wrk = {"trans": wt, "time": wtime}

        out[fips_prefix + code] = {"res": res, "wrk": wrk}

    return out


def _build_district_data(year, xw):
    """Aggregate tract-level ACS to house and senate districts via block-count weights.

    Tracts do not nest cleanly within legislative districts (~40% split for house).
    Each tract's ACS values are split proportionally by the number of crosswalk
    blocks that fall in each (tract, district) intersection.

    Returns:
        house_data:  {house_fips: {"res": {...}, "wrk": None}}
        senate_data: {senate_fips: {"res": {...}, "wrk": None}}
    """
    import pandas as pd

    # ── Fetch tract-level residence data ──────────────────────────────────────
    rh, rr = _fetch(year, RES_VARS, "tract:*", f"state:{STATE}")
    if not rh or not rr:
        return {}, {}

    try:
        state_i  = rh.index("state")
        county_i = rh.index("county")
        tract_i  = rh.index("tract")
    except ValueError:
        return {}, {}

    # Build {tract_fips: parsed_row} where tract_fips = state+county+tract (11 chars)
    tract_res = {}
    for row in rr:
        fips = row[state_i] + row[county_i] + row[tract_i]
        trans = _parse_trans(row, rh, "B08301")
        ttime = _parse_time(row, rh, "B08303")
        if trans or ttime:
            tract_res[fips] = {"trans": trans, "time": ttime}

    if not tract_res:
        return {}, {}

    time.sleep(0.25)

    # ── Build block-count weights: (tract_fips, dist_fips) -> block_count ─────
    # crosswalk trct column is the full 11-char tract FIPS
    xw_valid = xw[xw["trct"].notna() & xw["stsldl"].notna() & xw["stsldu"].notna()].copy()

    # house: group by (tract, house_district)
    house_weights = (
        xw_valid.groupby(["trct", "stsldl"])["tabblk2020"]
        .count()
        .reset_index(name="blocks")
    )
    tract_totals_h = house_weights.groupby("trct")["blocks"].sum().rename("total")
    house_weights = house_weights.join(tract_totals_h, on="trct")
    house_weights["weight"] = house_weights["blocks"] / house_weights["total"]

    # senate: group by (tract, senate_district)
    senate_weights = (
        xw_valid.groupby(["trct", "stsldu"])["tabblk2020"]
        .count()
        .reset_index(name="blocks")
    )
    tract_totals_s = senate_weights.groupby("trct")["blocks"].sum().rename("total")
    senate_weights = senate_weights.join(tract_totals_s, on="trct")
    senate_weights["weight"] = senate_weights["blocks"] / senate_weights["total"]

    def _weighted_sum(weights_df, dist_col, tract_res):
        """Aggregate tract ACS to districts using precomputed weights."""
        dist_data = {}
        for _, w_row in weights_df.iterrows():
            tfips = w_row["trct"]
            dfips = w_row[dist_col]
            wt    = float(w_row["weight"])
            if tfips not in tract_res:
                continue
            src = tract_res[tfips]
            if dfips not in dist_data:
                dist_data[dfips] = {"trans": {}, "time": {}}

            # Accumulate transportation mode counts
            if src["trans"]:
                for k, v in src["trans"].items():
                    if v is not None:
                        dist_data[dfips]["trans"][k] = (
                            dist_data[dfips]["trans"].get(k, 0) + round(v * wt)
                        )
            # Accumulate travel time counts
            if src["time"]:
                for k, v in src["time"].items():
                    if v is not None:
                        dist_data[dfips]["time"][k] = (
                            dist_data[dfips]["time"].get(k, 0) + round(v * wt)
                        )

        # Wrap in res/wrk schema; drop districts with no usable data
        out = {}
        for dfips, d in dist_data.items():
            trans = d["trans"] if d["trans"].get("total", 0) > 0 else None
            ttime = d["time"]  if d["time"].get("total", 0)  > 0 else None
            if trans or ttime:
                out[dfips] = {"res": {"trans": trans, "time": ttime}, "wrk": None}
        return out

    house_data  = _weighted_sum(house_weights,  "stsldl", tract_res)
    senate_data = _weighted_sum(senate_weights, "stsldu", tract_res)
    return house_data, senate_data


def fetch_acs_year(year: int, data_dir: Path, force: bool = False, xw=None) -> None:
    """Fetch and save ACS commute data for one year.

    Writes:
      data_dir/acs/{year}/acs_city.json
      data_dir/acs/{year}/acs_county.json
      data_dir/acs/{year}/acs_house.json   (tract-aggregated to house districts)
      data_dir/acs/{year}/acs_senate.json  (tract-aggregated to senate districts)

    Skips if all four files already exist (pass force=True to re-fetch).
    xw: optional pre-loaded crosswalk DataFrame (avoids re-reading from disk).
    """
    if year < ACS_START_YEAR:
        print(f"  ACS data not available before {ACS_START_YEAR}, skipping {year}.")
        return

    out_dir     = data_dir / "acs" / str(year)
    city_path   = out_dir / "acs_city.json"
    county_path = out_dir / "acs_county.json"
    house_path  = out_dir / "acs_house.json"
    senate_path = out_dir / "acs_senate.json"

    if not force and all(p.exists() for p in [city_path, county_path, house_path, senate_path]):
        print(f"  {year}: ACS already cached, skipping.")
        return

    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"  Fetching ACS 5-year for {year}...")

    city_data = _build_geo_data(
        year, "place:*", f"state:{STATE}", "place", STATE,
    )
    city_path.write_text(json.dumps(city_data))
    print(f"    acs_city.json: {len(city_data)} places")

    time.sleep(0.5)

    county_data = _build_geo_data(
        year, "county:*", f"state:{STATE}", "county", STATE,
    )
    county_path.write_text(json.dumps(county_data))
    print(f"    acs_county.json: {len(county_data)} counties")

    time.sleep(0.5)

    # District ACS: aggregate tract-level data using block-count weights
    if xw is None:
        import pandas as pd
        cache_path = data_dir / "cache" / "ut_xwalk.csv.gz"
        if cache_path.exists():
            xw = pd.read_csv(
                cache_path,
                dtype={"tabblk2020": str, "trct": str, "stsldl": str, "stsldu": str},
                usecols=["tabblk2020", "trct", "stsldl", "stsldu"],
            )
            xw["stsldl"] = xw["stsldl"].str.zfill(5)
            xw["stsldu"] = xw["stsldu"].str.zfill(5)

    if xw is not None:
        house_data, senate_data = _build_district_data(year, xw)
        house_path.write_text(json.dumps(house_data))
        senate_path.write_text(json.dumps(senate_data))
        print(f"    acs_house.json: {len(house_data)} house districts")
        print(f"    acs_senate.json: {len(senate_data)} senate districts")
    else:
        house_path.write_text("{}")
        senate_path.write_text("{}")
        print("    District ACS skipped (crosswalk not available)")


if __name__ == "__main__":
    data_dir = Path(__file__).parent.parent / "data"
    import sys
    years = [int(a) for a in sys.argv[1:]] if len(sys.argv) > 1 else list(range(ACS_START_YEAR, 2024))
    for y in years:
        fetch_acs_year(y, data_dir)
