import { MissionControlDashboard } from "../components/mission-control-dashboard";
import { getMissionControlSnapshot } from "../lib/mission-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function HomePage() {
  const initialSnapshot = await getMissionControlSnapshot();
  return <MissionControlDashboard initialSnapshot={initialSnapshot} />;
}
