// Paste into browser console on the Simulation tab (PP.sim must be active)
(async () => {
  const { ppGetRequirementPerPortion, ppPlannedQty } = await import("./production-planner.js");
  const menu = window.allMenu || {};
  const inv = window.allInventory || {};
  const sfp = window.allSemiFinished || {};
  const rows = [];

  for (const menuId of Object.keys(menu)) {
    const planned = ppPlannedQty(menuId);
    if (planned <= 0) continue;
    const req = await ppGetRequirementPerPortion(menuId);
    let costPerPortion = 0;
    for (const [ingId, amt] of req.ing) costPerPortion += amt * Number(inv[ingId]?.price || 0);
    for (const [sfpId, amt] of req.sfp) costPerPortion += amt * Number(sfp[sfpId]?.price || 0);
    const price = Number(menu[menuId]?.price || 0);
    const profitPerPortion = price - costPerPortion;
    rows.push({
      name: menu[menuId]?.name?.uz || menu[menuId]?.name || menuId,
      planned,
      price,
      costPerPortion: Math.round(costPerPortion),
      profitPerPortion: Math.round(profitPerPortion),
      totalProfit: Math.round(profitPerPortion * planned),
      flag: price === 0 ? "⚠️ NO PRICE SET" : profitPerPortion < 0 ? "🔴 LOSS-MAKING" : "✅ ok"
    });
  }

  rows.sort((a, b) => a.totalProfit - b.totalProfit);
  console.table(rows);
  console.log("Total sim profit:", rows.reduce((s, r) => s + r.totalProfit, 0));
})();