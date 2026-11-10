import PicksView from "@/components/PicksView";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";

export const dynamic = "force-dynamic";

export default function PicksPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Paper picks: the plays the movement model flags, graded" sport="cbb" />
      <PicksView />
      <SiteFooter />
    </div>
  );
}
