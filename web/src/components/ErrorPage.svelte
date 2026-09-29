<script lang="ts">
  interface Props {
    status?: number;
    title: string;
    message: string;
    detail?: string;
    onretry?: () => void;
    /** signed in, but without access: a way out to another account */
    onsignout?: () => void;
  }
  let { status, title, message, detail, onretry, onsignout }: Props = $props();
</script>

<section>
  {#if status}<p class="code num">{status === 0 ? "offline" : status}</p>{/if}
  <h1>{title}</h1>
  <p class="message">{message}</p>
  <div class="actions">
    {#if onretry}<button class="primary" onclick={onretry}>Try again</button>{/if}
    {#if onsignout}<button onclick={onsignout}>Sign out</button>{:else}<a href="#/">Back to workspaces</a>{/if}
  </div>
  {#if detail}
    <details>
      <summary>Details</summary>
      <pre>{detail}</pre>
    </details>
  {/if}
</section>

<style>
  section {
    max-width: 35rem;
    margin: 18vh auto 0;
    padding: 0 1.5rem;
  }
  .code {
    margin: 0 0 0.375rem;
    font: 0.75rem var(--mono);
    color: var(--muted);
  }
  h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .message {
    margin: 0.5rem 0 1.25rem;
    color: var(--ink-2);
    line-height: 1.6;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    font-size: 0.8125rem;
  }
  .primary {
    color: var(--ink);
    border: 1px solid var(--hair);
    background: var(--surface);
    padding: 0.25rem 0.75rem;
    border-radius: 6px;
  }
  a {
    color: var(--ink-2);
    text-decoration: underline;
    text-decoration-color: var(--axis);
    text-underline-offset: 3px;
  }
  a:hover {
    color: var(--ink);
  }
  details {
    margin-top: 1.75rem;
  }
  summary {
    font-size: 0.75rem;
    color: var(--muted);
    cursor: pointer;
  }
  pre {
    margin: 0.5rem 0 0;
    padding: 0.625rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 6px;
    font-size: 0.75rem;
    overflow: auto;
    max-height: 40vh;
    white-space: pre-wrap;
  }
</style>
