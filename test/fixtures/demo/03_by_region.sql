-- `enrich` is the Python cell above, read by basalt as a table.
SELECT region,
       COUNT(*)                 AS orders,
       ROUND(SUM(amount_tax), 2) AS revenue
FROM enrich
GROUP BY region
ORDER BY revenue DESC;
