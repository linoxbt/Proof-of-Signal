"use client";

// MapLibre basemap + deck.gl overlay. Basemap: Protomaps PMTiles from
// NEXT_PUBLIC_PMTILES_URL, or a plain background when unset (no third-party
// tile server, ever). Load with next/dynamic and ssr: false.
import type { LayersList, PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { layers as protomapsLayers, namedFlavor } from "@protomaps/basemaps";
import { Map as MlMap, NavigationControl, addProtocol, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";
import { BASEMAP_GLYPHS_URL, PMTILES_URL } from "@/lib/config";

export type Bounds = [[number, number], [number, number]];

export interface DeckMapProps {
  layers: LayersList;
  bounds?: Bounds | null;
  ariaLabel: string;
  className?: string;
  getTooltip?: (info: PickingInfo) => string | null;
  onUnavailable?: () => void;
}

let protocolAdded = false;

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function basemapStyle(): StyleSpecification {
  if (!PMTILES_URL) {
    return {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#e7ecf1" } }],
    };
  }
  const style: StyleSpecification = {
    version: 8,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${PMTILES_URL}`,
        attribution: '<a href="https://openstreetmap.org/copyright">© OpenStreetMap</a>',
      },
    },
    layers: protomapsLayers("protomaps", namedFlavor("light"), BASEMAP_GLYPHS_URL ? { lang: "en" } : undefined),
  };
  if (BASEMAP_GLYPHS_URL) style.glyphs = BASEMAP_GLYPHS_URL;
  return style;
}

/** Bounds of a set of [lng, lat] points, or null. */
export function boundsOf(points: [number, number][]): Bounds | null {
  if (!points.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const pad = 0.005;
  return [
    [minX - pad, minY - pad],
    [maxX + pad, maxY + pad],
  ];
}

export default function DeckMap({ layers, bounds, ariaLabel, className, getTooltip, onUnavailable }: DeckMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [ready, setReady] = useState(false);
  const tooltipRef = useRef(getTooltip);
  useEffect(() => {
    tooltipRef.current = getTooltip;
  });
  const unavailableRef = useRef(onUnavailable);
  useEffect(() => {
    unavailableRef.current = onUnavailable;
  });

  useEffect(() => {
    if (!container.current) return;
    if (!hasWebGL()) {
      unavailableRef.current?.();
      return;
    }
    setWorkerUrl("/vendor/maplibre-gl-worker.mjs");
    if (PMTILES_URL && !protocolAdded) {
      const protocol = new Protocol();
      addProtocol("pmtiles", protocol.tile);
      protocolAdded = true;
    }
    let map: MlMap;
    try {
      map = new MlMap({
        container: container.current,
        style: basemapStyle(),
        center: [8.0, 9.1], // Nigeria
        zoom: 5,
        attributionControl: PMTILES_URL ? { compact: true } : false,
        dragRotate: false,
        pitchWithRotate: false,
        cooperativeGestures: false,
      });
    } catch {
      unavailableRef.current?.();
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      getTooltip: (info) => {
        const text = tooltipRef.current?.(info);
        return text
          ? {
              text,
              style: {
                background: "#111827",
                color: "#ffffff",
                fontSize: "13px",
                padding: "6px 8px",
                borderRadius: "6px",
                maxWidth: "260px",
                whiteSpace: "pre-line",
              },
            }
          : null;
      },
    });
    map.addControl(overlay);
    mapRef.current = map;
    overlayRef.current = overlay;
    map.once("load", () => setReady(true));
    return () => {
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers, ready]);

  const boundsKey = bounds ? bounds.flat().map((n) => n.toFixed(4)).join(",") : "";
  useEffect(() => {
    if (!ready || !bounds || !mapRef.current) return;
    mapRef.current.fitBounds(bounds, { padding: 32, duration: 0, maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, boundsKey]);

  return <div ref={container} className={className} role="region" aria-label={ariaLabel} data-testid="map" data-map-ready={ready ? "true" : "false"} />;
}
