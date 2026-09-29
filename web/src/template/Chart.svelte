<script lang="ts">
  import Output from "./Output.svelte";

  // A cell's chart (Altair, df.plot, matplotlib): its output without the table or text.
  let { cell }: { cell: string } = $props();
</script>

<Output {cell} parts={["chart"]} />
