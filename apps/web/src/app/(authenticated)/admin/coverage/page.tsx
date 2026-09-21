// Coverage has moved to Home as Your Data. Keep this route as a redirect so
// old bookmarks do not retain a second, operational version of the inventory.

import { redirect } from "next/navigation";

export default async function AdminCoveragePage() {
  redirect("/");
}
