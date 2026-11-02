import { redirect } from "next/navigation";

// The paper picks live on the Desk now; this keeps old links and the Exchange menu working.
export default function PicksRedirect() {
  redirect("/picks");
}
