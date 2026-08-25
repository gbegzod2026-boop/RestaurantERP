export function drawFoodChart(data) {
  if (!Array.isArray(data)) {
    console.warn("drawFoodChart: data array emas", data);
    return;
  }

  const ctx = document.getElementById("foodChart");
  if (!ctx) return;

  new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map(item => item.name?.uz || "—"),
      datasets: [{
        label: "Taomlar",
        data: data.map(item => item.price || 0),
      }]
    }
  });
}

const FOODIFY_COLORS = {
  orange: "#ff9f1c",
  orangeSoft: "rgba(255,159,28,0.4)",
  dark: "#1f2937",
  gray: "#9ca3af",
  green: "#22c55e",
  red: "#ef4444",
  blue: "#3b82f6"
};

function renderStatusChart(statusCount) {
  const ctx = document.getElementById("statusChart");
  if (statusChart) statusChart.destroy();

  statusChart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: Object.keys(statusCount).map(k => t(k)),
      datasets: [{
        data: Object.values(statusCount),
        backgroundColor: [
          FOODIFY_COLORS.orange,
          FOODIFY_COLORS.green,
          FOODIFY_COLORS.blue,
          FOODIFY_COLORS.red
        ]
      }]
    },
    options: {
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: FOODIFY_COLORS.dark }
        }
      }
    }
  });
}

function renderTopFoodsChart(filteredOrders) {
  const topFoods = calculateTopFoods(filteredOrders);
  if (!topFoods.length) return;

  if (topFoodsChart) topFoodsChart.destroy();

  topFoodsChart = new Chart(
    document.getElementById("topFoodsChart"),
    {
      type: "bar",
      data: {
        labels: topFoods.map(i => i[0]),
        datasets: [{
          label: t("top_foods"),
          data: topFoods.map(i => i[1]),
          backgroundColor: FOODIFY_COLORS.orangeSoft,
          borderColor: FOODIFY_COLORS.orange,
          borderWidth: 2,
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            ticks: { color: FOODIFY_COLORS.dark }
          },
          y: {
            ticks: { color: FOODIFY_COLORS.dark }
          }
        }
      }
    }
  );
}

