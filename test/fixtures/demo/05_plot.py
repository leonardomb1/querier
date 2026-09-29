import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(5, 2.5))
ax.bar(by_region["region"], by_region["revenue"], color="#444")
ax.spines[["top", "right"]].set_visible(False)
