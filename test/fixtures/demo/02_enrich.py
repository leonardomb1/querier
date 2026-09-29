# `sales` is the previous cell's result, as a polars DataFrame.
sales.with_columns(
    (pl.col("amount") * 1.1).round(2).alias("amount_tax"),
    pl.col("day").dt.month().alias("month"),
)
