PARAM days INT DEFAULT 90;

SELECT range AS id,
       CASE range % 4 WHEN 0 THEN 'north' WHEN 1 THEN 'south' WHEN 2 THEN 'east' ELSE 'west' END AS region,
       date_add('day', range % $days, CAST('2026-01-01' AS DATE)) AS day,
       CAST(range % 97 AS FLOAT) * 1.25 AS amount
FROM RANGE(5000);
