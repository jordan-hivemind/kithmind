// Getting started is folded into Settings (the Connect section). The route
// stays so an old bookmark lands somewhere useful.

import { redirect } from "next/navigation";

export default function GettingStartedPage() {
  redirect("/settings#connect");
}
