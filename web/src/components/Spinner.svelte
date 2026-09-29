<script lang="ts">
  let { size = 18, label = "Loading" }: { size?: number; label?: string } = $props();
</script>

<span class="spinner" role="status" aria-label={label} style:width="{size}px" style:height="{size}px"></span>

<style>
  .spinner {
    display: inline-block;
    border-radius: 50%;
    border: 2px solid var(--grid);
    border-top-color: var(--ink-2);
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
