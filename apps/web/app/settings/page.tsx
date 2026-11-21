import { WorkspaceShell } from "@/components/WorkspaceShell";
import CloudHistoryStatus from "@/components/CloudHistoryStatus";
import ShopSettingsSections from "@/components/ShopSettingsSections";
import { archiveStatus } from "@/lib/engineering-archive";
import { EngineeringCatalog } from "@/components/EngineeringCatalog";
import { BlueprintRules } from "@/components/BlueprintRules";
import {cloudStatus} from "@/lib/cloud-history";
import EstimatingSettingsEditor from "@/components/EstimatingSettingsEditor";
import { getEstimatingProfiles, getRateHistory, shopDate } from "@/lib/estimating";
import { practiceReferences } from "@/lib/practice-rate-book";
import "../estimating.css";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const archive = archiveStatus();
  return <WorkspaceShell active="settings" breadcrumbs={[{ label: "Workspace", href: "/" }, { label: "Settings" }]}>
    <div className="est-workspace">
      <header className="est-heading"><div><h1>Shop settings</h1><p>Set the prices and job templates your shop uses for new estimates.</p></div></header>
      <ShopSettingsSections
        pricing={<EstimatingSettingsEditor initial={getEstimatingProfiles()} history={getRateHistory()} today={shopDate()} references={practiceReferences}/>}
        rules={archive.enabled && <><BlueprintRules/><EngineeringCatalog/></>}
        history={<><CloudHistoryStatus initial={await cloudStatus()}/>
          <details className="panel approval-fold"><summary>Engineering records</summary>
            <p>{archive.enabled ? `${archive.stored} approved versions archived · ${archive.pending} awaiting transfer` : "This workspace keeps its engineering approval records locally."}</p>
            {archive.issue && <p>{archive.issue}</p>}
          </details></>}
      />
    </div>
  </WorkspaceShell>;
}
