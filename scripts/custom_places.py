# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "geopandas>=0.14",
#   "shapely>=2.0",
# ]
# ///
"""
Custom Places — modular extension for non-Census employment sites.

Adds entities like Hill Air Force Base that are significant commute
destinations but have no Census place designation (or whose LEHD
coverage differs from their true footprint).

Add new places by drawing a polygon in data/custom_places.gpkg and
setting its `name` field.  No other file changes needed.

Three merge-point functions are called by process_data.py:

  get_custom_block_map(xwalk_df)   -> dict[name -> frozenset[block_fips]]
  apply_custom_places(lookup)      -> mutated lookup dict
  inject_custom_meta(meta_list)    -> extended list
  append_custom_boundaries(gdf)    -> extended GeoDataFrame
"""

import json
from pathlib import Path

import pandas as pd
import geopandas as gpd
from shapely.geometry import Point

DATA_DIR  = Path(__file__).parent.parent / "data"
CACHE_DIR = DATA_DIR / "cache"
CUSTOM_FILE = DATA_DIR / "custom_places.gpkg"

# Set to True to include custom places (e.g. Hill Air Force Base) in the
# pipeline output.  When False all four merge-point functions are no-ops,
# but export_for_app() still runs so the app can show info-only polygons.
ENABLED = False

# Metadata for the app's info-only display (shown when ENABLED = False).
# Keyed by the 'name' field in custom_places.gpkg.
CUSTOM_PLACE_NOTES = {
    "Hill Air Force Base": {
        "county": "Davis County",
        "county_fips": "49011",
        "employees_approx": "~27,000",
        "note": (
            "Federal civilian and military positions are excluded from LEHD "
            "wage records (not UI-covered employment). Only private contractor "
            "jobs appear in this dataset, significantly underrepresenting "
            "actual commute volumes to this site."
        ),
    },
}

# Synthetic place FIPS base — high enough to never collide with real Utah FIPS.
# Each custom place gets 49900XX where XX is its index in the layer.
_SYNTH_FIPS_BASE = 4990000


def _load_custom_layer() -> gpd.GeoDataFrame:
    """Load all features from custom_places.gpkg in WGS-84."""
    if not CUSTOM_FILE.exists():
        return gpd.GeoDataFrame(columns=["name", "geometry"])
    gdf = gpd.read_file(CUSTOM_FILE, layer="custom_places")
    if "name" not in gdf.columns:
        raise ValueError(f"{CUSTOM_FILE} must have a 'name' column on each feature.")
    return gdf.to_crs(epsg=4326)


def _cache_path() -> Path:
    return CACHE_DIR / "custom_blocks.json"


def _cache_valid(custom_gdf: gpd.GeoDataFrame) -> bool:
    cache = _cache_path()
    if not cache.exists():
        return False
    # Invalidate if custom_places.gpkg is newer than the cache.
    return CUSTOM_FILE.stat().st_mtime <= cache.stat().st_mtime


def get_custom_block_map(xwalk_df: pd.DataFrame) -> dict:
    if not ENABLED:
        return {}
    """Return {place_name: frozenset(tabblk2020)} for every custom place.

    Uses blklat/blklon from the LEHD crosswalk for point-in-polygon.
    Result is cached to data/cache/custom_blocks.json.
    """
    custom_gdf = _load_custom_layer()
    if custom_gdf.empty:
        return {}

    if _cache_valid(custom_gdf):
        print("  Using cached custom block map.")
        raw = json.loads(_cache_path().read_text())
        return {k: frozenset(v) for k, v in raw.items()}

    print("  Building custom place -> block map (spatial join)...")

    if "blklatdd" not in xwalk_df.columns or "blklondd" not in xwalk_df.columns:
        raise ValueError(
            "LEHD crosswalk is missing blklatdd/blklondd columns — "
            "cannot run spatial join for custom places."
        )

    blocks_gdf = gpd.GeoDataFrame(
        xwalk_df[["tabblk2020"]].copy(),
        geometry=[Point(lon, lat) for lat, lon in
                  zip(xwalk_df["blklatdd"], xwalk_df["blklondd"])],
        crs="EPSG:4326",
    )

    block_map = {}
    for _, place in custom_gdf.iterrows():
        name = place["name"]
        mask = blocks_gdf.within(place.geometry)
        matched = frozenset(blocks_gdf.loc[mask, "tabblk2020"].tolist())
        block_map[name] = matched
        print(f"    {name}: {len(matched)} blocks matched")

    # Persist cache
    CACHE_DIR.mkdir(exist_ok=True)
    _cache_path().write_text(
        json.dumps({k: list(v) for k, v in block_map.items()}, indent=2)
    )
    print(f"  Cached custom block map -> {_cache_path().name}")
    return block_map


def apply_custom_places(lookup: dict, block_map: dict) -> dict:
    if not ENABLED:
        return lookup
    """Override city assignment for all blocks that fall inside a custom place.

    Mutates and returns the lookup dict produced by build_lookup().
    Called BEFORE fill_unincorporated() so custom names win over both
    Census place names and the unincorporated fallback.
    """
    if not block_map:
        return lookup

    custom_gdf = _load_custom_layer()
    # Build synthetic FIPS keyed by name
    synth_fips = {
        row["name"]: str(_SYNTH_FIPS_BASE + i).zfill(7)
        for i, row in custom_gdf.reset_index().iterrows()
    }

    for name, blocks in block_map.items():
        fips = synth_fips.get(name, "0000000")
        for block in blocks:
            if block in lookup:
                lookup[block]["city_name"] = name
                lookup[block]["place_fips"] = fips
    return lookup


def inject_custom_meta(meta_list: list) -> list:
    if not ENABLED:
        return meta_list
    """Append a metadata entry for each custom place.

    Centroid is computed from the boundary polygon.
    Called after build_city_meta() so it appends without affecting TIGER lookups.
    """
    custom_gdf = _load_custom_layer()
    if custom_gdf.empty:
        return meta_list

    # Index existing entries by name so we can update null-centroid entries.
    name_to_idx = {m["name"]: i for i, m in enumerate(meta_list)}

    for i, row in custom_gdf.iterrows():
        name = row["name"]
        centroid = row.geometry.centroid
        synth_fips = str(_SYNTH_FIPS_BASE + i).zfill(7)

        if name in name_to_idx:
            entry = meta_list[name_to_idx[name]]
            if entry.get("lat") is None:
                # build_city_meta added a null-centroid stub — fill it in.
                entry["lat"] = round(centroid.y, 6)
                entry["lon"] = round(centroid.x, 6)
                entry["place_fips"] = synth_fips
                print(f"  Updated custom place centroid: {name} ({centroid.y:.4f}, {centroid.x:.4f})")
            # else: TIGER already found a valid centroid — leave it alone.
        else:
            meta_list.append({
                "name": name,
                "county": row.get("county", ""),
                "county_fips": row.get("county_fips", ""),
                "lat": round(centroid.y, 6),
                "lon": round(centroid.x, 6),
                "place_fips": synth_fips,
            })
            print(f"  Injected custom place metadata: {name} ({centroid.y:.4f}, {centroid.x:.4f})")

    return meta_list


def append_custom_boundaries(city_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if not ENABLED:
        return city_gdf
    """Append custom place polygons to the city boundaries GeoDataFrame.

    Reprojects and simplifies to match city_gdf (already in EPSG:26912, 100 m tolerance).
    Called after TIGER city boundary processing.
    """
    custom_gdf = _load_custom_layer()
    if custom_gdf.empty:
        return city_gdf

    custom_proj = custom_gdf[["name", "geometry"]].copy()
    custom_proj = custom_proj.to_crs(city_gdf.crs)
    custom_proj["geometry"] = custom_proj["geometry"].simplify(100, preserve_topology=True)

    result = pd.concat([city_gdf, custom_proj], ignore_index=True)
    print(f"  Appended {len(custom_proj)} custom place boundary/ies to city GeoDataFrame.")
    return gpd.GeoDataFrame(result, crs=city_gdf.crs)


def export_for_app(data_dir: Path) -> None:
    """Export data/custom_places.geojson for the app — always runs regardless of ENABLED.

    When ENABLED=False the app uses this file to render info-only polygons with a
    click popup explaining why data is unavailable.  When ENABLED=True the app
    treats the place as a normal city and ignores this file for that feature.
    """
    import json as _json

    custom_gdf = _load_custom_layer()
    if custom_gdf.empty:
        return

    features = []
    for _, row in custom_gdf.iterrows():
        name = row["name"]
        info = CUSTOM_PLACE_NOTES.get(name, {})
        geom = row.geometry.simplify(0.0001, preserve_topology=True)
        features.append({
            "type": "Feature",
            "geometry": geom.__geo_interface__,
            "properties": {
                "name": name,
                "county": info.get("county", ""),
                "county_fips": info.get("county_fips", ""),
                "employees_approx": info.get("employees_approx", ""),
                "note": info.get("note", ""),
            },
        })

    out_path = data_dir / "custom_places.geojson"
    out_path.write_text(_json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"  Exported {out_path.name} ({len(features)} feature(s))")
