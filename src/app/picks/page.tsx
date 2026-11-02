import PicksView from "@/components/PicksView";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";

export const dynamic = "force-dynamic";

export default function PicksPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Paper picks: what the models would play, graded" sport="desk" />
      <PicksView />
      <SiteFooter />
    </div>
  );
}
