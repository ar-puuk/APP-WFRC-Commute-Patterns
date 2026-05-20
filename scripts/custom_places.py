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

To add a new place:
  1. Draw a polygon in data/custom_places.gpkg and set its `name` field.
  2. Add an entry to scripts/custom_places_config.json with at minimum
     `enable` (true/false) and `note`.

Per-place `enable` controls pipeline inclusion:
  - true  → blocks are reassigned, meta/boundaries injected, treated as a
             normal selectable city in the app.
  - false → info-only: polygon rendered on the map with a click popup;
             sidebar and Credits modal show a data-limitation disclaimer.

Four merge-point functions are called by process_data.py:

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

DATA_DIR    = Path(__file__).parent.parent / "data"
CACHE_DIR   = DATA_DIR / "cache"
CUSTOM_FILE = DATA_DIR / "custom_places.gpkg"
CONFIG_FILE = Path(__file__).parent / "custom_places_config.json"

# Load per-place config at module level.
_CONFIG: dict = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}

# Synthetic place FIPS base — high enough to never collide with real Utah FIPS.
# Each custom place gets 49900XX where XX is its index in the layer.
_SYNTH_FIPS_BASE = 4990000


def _place_cfg(name: str) -> dict:
    return _CONFIG.get(name, {})


def _is_enabled(name: str) -> bool:
    return _place_cfg(name).get("enable", False)


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


def _cache_valid() -> bool:
    """Cache covers all place geometries; invalidate only when .gpkg changes."""
    cache = _cache_path()
    if not cache.exists():
        return False
    return CUSTOM_FILE.stat().st_mtime <= cache.stat().st_mtime


def get_custom_block_map(xwalk_df: pd.DataFrame) -> dict:
    """Return {place_name: frozenset(tabblk2020)} for every enabled custom place.

    Uses blklat/blklon from the LEHD crosswalk for point-in-polygon.
    The block map is cached for ALL places in the layer; only enabled
    places are returned so callers never see disabled entries.
    """
    custom_gdf = _load_custom_layer()
    if custom_gdf.empty:
        return {}

    if _cache_valid():
        print("  Using cached custom block map.")
        raw = json.loads(_cache_path().read_text())
        return {k: frozenset(v) for k, v in raw.items() if _is_enabled(k)}

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

    CACHE_DIR.mkdir(exist_ok=True)
    _cache_path().write_text(
        json.dumps({k: list(v) for k, v in block_map.items()}, indent=2)
    )
    print(f"  Cached custom block map -> {_cache_path().name}")

    return {name: blocks for name, blocks in block_map.items() if _is_enabled(name)}


def apply_custom_places(lookup: dict, block_map: dict) -> dict:
    """Override city assignment for all blocks that fall inside a custom place.

    Mutates and returns the lookup dict produced by build_lookup().
    Called BEFORE fill_unincorporated() so custom names win over both
    Census place names and the unincorporated fallback.
    block_map already contains only enabled places (from get_custom_block_map).
    """
    if not block_map:
        return lookup

    custom_gdf = _load_custom_layer()
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
    """Append a metadata entry for each enabled custom place.

    Centroid is computed from the boundary polygon.
    Called after build_city_meta() so it appends without affecting TIGER lookups.
    """
    custom_gdf = _load_custom_layer()
    custom_gdf = custom_gdf[custom_gdf["name"].apply(_is_enabled)]
    if custom_gdf.empty:
        return meta_list

    name_to_idx = {m["name"]: i for i, m in enumerate(meta_list)}

    for i, row in custom_gdf.iterrows():
        name = row["name"]
        centroid = row.geometry.centroid
        synth_fips = str(_SYNTH_FIPS_BASE + i).zfill(7)

        if name in name_to_idx:
            entry = meta_list[name_to_idx[name]]
            if entry.get("lat") is None:
                entry["lat"] = round(centroid.y, 6)
                entry["lon"] = round(centroid.x, 6)
                entry["place_fips"] = synth_fips
                print(f"  Updated custom place centroid: {name} ({centroid.y:.4f}, {centroid.x:.4f})")
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
    """Append enabled custom place polygons to the city boundaries GeoDataFrame.

    Reprojects and simplifies to match city_gdf (already in EPSG:26912, 100 m tolerance).
    Called after TIGER city boundary processing.
    """
    custom_gdf = _load_custom_layer()
    custom_gdf = custom_gdf[custom_gdf["name"].apply(_is_enabled)]
    if custom_gdf.empty:
        return city_gdf

    custom_proj = custom_gdf[["name", "geometry"]].copy()
    custom_proj = custom_proj.to_crs(city_gdf.crs)
    custom_proj["geometry"] = custom_proj["geometry"].simplify(100, preserve_topology=True)

    result = pd.concat([city_gdf, custom_proj], ignore_index=True)
    print(f"  Appended {len(custom_proj)} custom place boundary/ies to city GeoDataFrame.")
    return gpd.GeoDataFrame(result, crs=city_gdf.crs)


def export_for_app(data_dir: Path) -> None:
    """Export data/custom_places.geojson for the app — always runs for all places.

    When enable=false the app renders the polygon as an info-only marker
    with a click popup and shows a data-limitation disclaimer.
    When enable=true the app treats the place as a normal city.
    """
    custom_gdf = _load_custom_layer()
    if custom_gdf.empty:
        return

    features = []
    for _, row in custom_gdf.iterrows():
        name = row["name"]
        cfg = _place_cfg(name)
        geom = row.geometry.simplify(0.0001, preserve_topology=True)
        features.append({
            "type": "Feature",
            "geometry": geom.__geo_interface__,
            "properties": {
                "name": name,
                "county": cfg.get("county", ""),
                "county_fips": cfg.get("county_fips", ""),
                "employees_approx": cfg.get("employees_approx", ""),
                "enable": cfg.get("enable", False),
                "note": cfg.get("note", ""),
            },
        })

    out_path = data_dir / "custom_places.geojson"
    out_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"  Exported {out_path.name} ({len(features)} feature(s))")
