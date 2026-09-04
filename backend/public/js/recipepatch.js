// ============================================================
// 🧪 RECIPE MODAL — TO'LIQ TUZATILGAN VA YANGILANGAN QISM
// admin.js faylida quyidagi funksiyalarni ALMASHTIRING:
//   1. window.openRecipeModal         (~line 5002)
//   2. window.addIngredientRowToRecipe (~line 5028)
//   3. window.saveRecipe               (~line 5054)
//   4. window.closeRecipeModal         (~line 5082)
//   5. async function deductStock      (~line 2706)  ← eski, o'chiring yoki almashtiring
// ============================================================

// ─────────────────────────────────────────────
// 1) RECIPE MODAL OCHISH
// ─────────────────────────────────────────────
window.openRecipeModal = function (menuId, foodName) {
  window.currentRecipeMenuId = menuId;
  const menu = window.allMenu[menuId];
  if (!menu) return;

  // Modal sarlavhasi
  const modalTitle = document.getElementById('recipe-food-name');
  const finalName = foodName
    || (menu.name && (menu.name[getLang?.() || 'uz'] || menu.name.uz || menu.name.ru || menu.name.en))
    || menu.name
    || (typeof t === 'function' ? t("food_label", "Taom") : "Taom");
  if (modalTitle) {
    modalTitle.innerText = finalName + " — " + (typeof t === 'function' ? t("ingredients", "tarkibi") : "tarkibi");
  }

  // Satr konteynerini tozalash
  const container = document.getElementById("recipe-items-container");
  if (!container) return;
  container.innerHTML = "";

  // Mavjud retseptni yuklash
  const recipe = Array.isArray(menu.recipe) ? menu.recipe : [];
  if (recipe.length === 0) {
    window.addIngredientRowToRecipe();
  } else {
    recipe.forEach(ing => window.addIngredientRowToRecipe(ing.id, ing.amount));
  }

  // Modalni ko'rsatish
  const modal = document.getElementById("recipeModal")
    || document.getElementById("recipe-modal")
    || document.querySelector('[data-modal="recipe"]');
  if (modal) modal.style.display = "flex";
};

// ─────────────────────────────────────────────
// 2) RECIPE QATORINI QO'SHISH (birlik + miqdor)
// ─────────────────────────────────────────────
window.addIngredientRowToRecipe = function (selectedIngId = "", amount = "") {
  const container = document.getElementById("recipe-items-container");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "recipe-row";
  row.style.cssText = "display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap;";

  // Inventory dan masalliqlar ro'yxatini olish
  const inv = window.allInventory || {};
  let options = `<option value="">-- ${typeof t === 'function' ? t("select_ingredient", "Masalliq tanlang") : "Masalliq tanlang"} --</option>`;
  Object.entries(inv).forEach(([id, item]) => {
    const isSelected = id === selectedIngId ? "selected" : "";
    const unit = item.unit || "gr";
    const name = item.name || (typeof t === 'function' ? t("unnamed_product", "Nomsiz mahsulot") : "Nomsiz mahsulot");
    options += `<option value="${id}" ${isSelected} data-unit="${unit}">${name} (${unit})</option>`;
  });

  // Tanlangan masalliqning birligini aniqlash
  const selectedUnit = selectedIngId && inv[selectedIngId]
    ? (inv[selectedIngId].unit || "gr")
    : "";

  row.innerHTML = `
    <select class="recipe-ing-select" style="flex:2; min-width:160px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; outline:none; font-size:14px;">
      ${options}
    </select>
    <input type="number" 
           class="recipe-amount-input" 
           value="${amount}" 
           min="0.001" 
           step="0.001" 
           placeholder="${typeof t === 'function' ? t('quantity', 'Miqdori') : 'Miqdori'}" 
           style="flex:1; min-width:80px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; outline:none; font-size:14px;">
    <span class="recipe-unit-label" style="min-width:32px; font-size:13px; color:#64748b; font-weight:600;">${selectedUnit}</span>
    <button type="button" onclick="this.closest('.recipe-row').remove()" 
            style="padding:8px 12px; background:#ef4444; color:white; border:none; border-radius:6px; cursor:pointer; font-size:14px;" 
            title="${typeof t === 'function' ? t('delete_btn', "O'chirish") : "O'chirish"}">✖</button>
  `;

  // Select o'zgarganda birlik labelni yangilash
  const select = row.querySelector('.recipe-ing-select');
  const unitLabel = row.querySelector('.recipe-unit-label');
  select.addEventListener('change', function () {
    const selOpt = this.options[this.selectedIndex];
    unitLabel.textContent = selOpt ? (selOpt.dataset.unit || "") : "";
  });

  container.appendChild(row);
};

// ─────────────────────────────────────────────
// 3) RECIPE SAQLASH — ombor ham yangilanadi
//    menu/${id}/recipe  →  array [{id, amount}]
// ─────────────────────────────────────────────
window.saveRecipe = async function () {
  if (!window.currentRecipeMenuId) return;

  const container = document.getElementById("recipe-items-container");
  if (!container) return;

  const rows = container.querySelectorAll(".recipe-row");
  const newRecipe = [];

  rows.forEach(row => {
    const ingId = row.querySelector(".recipe-ing-select")?.value;
    const amount = Number(row.querySelector(".recipe-amount-input")?.value);
    if (ingId && amount > 0) {
      newRecipe.push({ id: ingId, amount: amount });
    }
  });

  const restId = localStorage.getItem("restaurantId");
  if (!restId) return;

  try {
    // menu/${menuId}/recipe ga array saqlash (deductOrderInventory ishlatadi)
    await update(ref(db, `restaurants/${restId}/menu/${window.currentRecipeMenuId}`), {
      recipe: newRecipe
    });

    // window.allMenu ni ham yangilash (local cache)
    if (window.allMenu && window.allMenu[window.currentRecipeMenuId]) {
      window.allMenu[window.currentRecipeMenuId].recipe = newRecipe;
    }

    const successMsg = typeof t === 'function'
      ? t("recipe_saved", "Retsept muvaffaqiyatli saqlandi!")
      : "Retsept muvaffaqiyatli saqlandi!";
    alert("✅ " + successMsg);

    if (typeof showAdminNotification === 'function') {
      showAdminNotification("✅ " + successMsg, "success");
    }

    window.closeRecipeModal();
  } catch (error) {
    const errMsg = typeof t === 'function' ? t("notify.error", "Xatolik yuz berdi: ") : "Xatolik yuz berdi: ";
    alert(errMsg + error.message);
  }
};

// ─────────────────────────────────────────────
// 4) RECIPE MODALNI YOPISH
// ─────────────────────────────────────────────
window.closeRecipeModal = function () {
  window.currentRecipeMenuId = null;
  const modal = document.getElementById("recipeModal")
    || document.getElementById("recipe-modal")
    || document.querySelector('[data-modal="recipe"]');
  if (modal) modal.style.display = "none";
};

// ─────────────────────────────────────────────
// 5) deductStock — YANGILANGAN (menu/recipe arrayni o'qiydi)
//    Bu funksiya approvePayment da chaqiriladi.
//    deductOrderInventory bilan bir xil ishni qiladi —
//    FAQAT BITTASINI ISHLATING. approvePayment ichida
//    "deductStock" ni "deductOrderInventory" ga o'zgartiring
//    (yoki quyidagi funksiyani joyiga qo'ying).
// ─────────────────────────────────────────────
async function deductStock(orderItems) {
  const restId = localStorage.getItem("restaurantId");
  if (!restId) return;

  for (const [, item] of Object.entries(orderItems)) {
    // menuId ni aniqlash (turli xil field nomlari)
    const menuId = item.menuId || item.id || item.itemId;
    if (!menuId) continue;

    const qty = Number(item.qty || 1);

    // menu dan recipe ni o'qish
    let recipe = [];
    if (window.allMenu && window.allMenu[menuId] && Array.isArray(window.allMenu[menuId].recipe)) {
      recipe = window.allMenu[menuId].recipe;
    } else {
      // Agar cache da yo'q bo'lsa Firebase dan o'qish
      try {
        const menuSnap = await get(ref(db, `restaurants/${restId}/menu/${menuId}`));
        if (menuSnap.exists()) {
          recipe = menuSnap.val().recipe || [];
        }
      } catch (e) {
        console.warn("Recipe o'qishda xato:", e);
        continue;
      }
    }

    // Har bir masalliq uchun ombordan ayirish
    for (const ing of recipe) {
      const ingId = ing.id;
      const needed = Number(ing.amount || 0) * qty;
      if (!ingId || needed <= 0) continue;

      const ingRef = ref(db, `restaurants/${restId}/inventory/${ingId}/stock`);
      try {
        await runTransaction(ingRef, (currentStock) => {
          if (currentStock === null) return 0;
          const newVal = currentStock - needed;
          return newVal;
        });

        // Kam qolgan bo'lsa ogohlantirish
        const afterSnap = await get(ingRef);
        const afterVal = afterSnap.val() ?? 0;
        const ingName = window.allInventory?.[ingId]?.name || ingId;
        if (afterVal <= 0) {
          const outMsg = (typeof t === 'function'
            ? t("rp_ingredient_out_of_stock", `"{name}" omborda tugadi!`)
            : `"{name}" omborda tugadi!`).replace("{name}", ingName);
          console.warn(`⛔ ${outMsg} (${afterVal})`);
          if (typeof showAdminNotification === 'function') {
            showAdminNotification(`⛔ ${outMsg}`, "error");
          }
        } else if (afterVal < 500) {
          const lowMsg = (typeof t === 'function'
            ? t("rp_ingredient_low_stock", `"{name}" kam qoldi: {qty}`)
            : `"{name}" kam qoldi: {qty}`).replace("{name}", ingName).replace("{qty}", afterVal);
          console.warn(`⚠️ ${lowMsg}`);
          if (typeof showAdminNotification === 'function') {
            showAdminNotification(`⚠️ ${lowMsg}`, "warning");
          }
        }
      } catch (e) {
        console.error(`Inventory ayirishda xato (${ingId}):`, e);
      }
    }
  }
}