/**
 * Leaflet map of the registry's stations (OpenStreetMap tiles, online only).
 * Loaded lazily by the Stations screen so Leaflet stays out of the main bundle.
 * Circle markers avoid Leaflet's image icons (which break under bundlers).
 */
import "leaflet/dist/leaflet.css";
import { useNavigate } from "@tanstack/react-router";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import type { Station } from "@/registry";

export default function StationsMap({ stations }: { stations: Station[] }) {
  const navigate = useNavigate();
  const located = stations.filter((s) => s.location && Number.isFinite(s.location.lat) && Number.isFinite(s.location.lng));
  if (located.length === 0) return null;
  const bounds: LatLngBoundsExpression = located.map((s) => [s.location!.lat, s.location!.lng] as [number, number]);
  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={{ padding: [40, 40], maxZoom: 15 }}
      scrollWheelZoom={false}
      className="relative z-0 h-64 w-full overflow-hidden rounded-lg border border-border md:h-80"
      style={{ background: "var(--card)" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      {located.map((s) => (
        <CircleMarker
          key={s.id}
          center={[s.location!.lat, s.location!.lng]}
          radius={9}
          pathOptions={{ color: s.active ? "#22d3ee" : "#94a3b8", fillColor: s.active ? "#22d3ee" : "#94a3b8", fillOpacity: 0.55, weight: 2 }}
          eventHandlers={{ click: () => void navigate({ to: "/stations/$id", params: { id: s.id } }) }}
        >
          <Tooltip>{s.name}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
