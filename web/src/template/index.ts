// What a report template imports as "querier".
//
//   <script>
//     import { Output, Chart, Table, Value, Control, setParam } from "querier";
//     let { cells, params } = $props();   // cells.monthly.rows, params.since
//   </script>

export { default as Output } from "./Output.svelte";
export { default as Chart } from "./Chart.svelte";
export { default as Table } from "./Table.svelte";
export { default as Value } from "./Value.svelte";
export { default as Control } from "./Control.svelte";
export { cells, params, setParam, type CellView } from "./runtime.svelte";
