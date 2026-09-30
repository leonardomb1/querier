<script lang="ts">
  import { api, splitId, type WorkspaceSummary } from "../../lib/api";
  import { canConfigure } from "../../lib/can";
  import { nbHref } from "../../lib/href";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import NotebookScope, { notebookToc } from "../settings/NotebookScope.svelte";
  import SettingsEditor from "../settings/SettingsEditor.svelte";
  import UserScope, { USER_TOC } from "../settings/UserScope.svelte";
  import WorkspaceScope, { workspaceToc } from "../settings/WorkspaceScope.svelte";

  // The Settings tab of a notebook's workbench: the user's, its workspace's and its own.
  let { ctl, wb }: { ctl: NotebookCtl; wb: Workbench } = $props();

  const [wsName, nbName] = $derived(splitId(ctl.name));
  let ws = $state<WorkspaceSummary | null>(null);
  async function loadWs() {
    try {
      ws = await api.workspace.get(wsName);
    } catch {}
  }
  loadWs();

  // a scope they may change nothing in isn't offered
  const scopes = $derived([
    { id: "user", label: "User" },
    ...(canConfigure(ws) ? [{ id: "workspace", label: "Workspace", hint: ws?.title ?? wsName }] : []),
    ...(notebookToc(ctl.book, ws).length ? [{ id: "notebook", label: "Notebook", hint: ctl.book?.title ?? nbName }] : []),
  ]);
  const scope = $derived(scopes.some((x) => x.id === wb.settingsScope) ? wb.settingsScope : "user");
  const toc = $derived(scope === "user" ? USER_TOC : scope === "workspace" ? workspaceToc(ws) : notebookToc(ctl.book, ws));
  function onscope(id: string) {
    wb.settingsScope = id as typeof wb.settingsScope;
    wb.settingsReveal = null;
  }
</script>

<SettingsEditor {scopes} {scope} {onscope} {toc} reveal={wb.settingsReveal} asked={wb.settingsAsked}>
  {#if scope === "user"}
    <UserScope />
  {:else if scope === "workspace"}
    {#if ws}
      {#key ws.name}
        <WorkspaceScope
          w={ws}
          onchanged={async () => {
            await loadWs();
            await ctl.refresh();
          }}
          renamed={(name) => (location.hash = nbHref(`${name}/${nbName}`))}
        />
      {/key}
    {/if}
  {:else}
    <NotebookScope {ctl} {ws} />
  {/if}
</SettingsEditor>
