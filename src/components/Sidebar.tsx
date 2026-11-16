import { useStore } from "../store";
import { Explorer } from "./sidebar/Explorer";
import { SearchView } from "./sidebar/SearchView";
import { SessionsView } from "./sidebar/SessionsView";
import { SkillsView } from "./sidebar/SkillsView";
import { AccountsView } from "./sidebar/AccountsView";
import { StructureView } from "./sidebar/StructureView";
import { RulesView } from "./sidebar/RulesView";
import { SlackView } from "./sidebar/SlackView";

export function Sidebar() {
  const activity = useStore((s) => s.activity);
  const width = useStore((s) => s.sidebarWidth);
  return (
    <aside className="sidebar" style={{ width }}>
      {activity === "files" && <Explorer />}
      {activity === "search" && <SearchView />}
      {activity === "claude" && <SessionsView />}
      {activity === "rules" && <RulesView />}
      {activity === "slack" && <SlackView />}
      {activity === "skills" && <SkillsView />}
      {activity === "accounts" && <AccountsView />}
      {activity === "structure" && <StructureView />}
    </aside>
  );
}

export function SideHeader({ title, children, sub }: { title: string; children?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="side-header">
      <div className="side-title">
        <span>{title}</span>
        {sub && <span className="side-sub">{sub}</span>}
      </div>
      <div className="side-actions">{children}</div>
    </div>
  );
}
