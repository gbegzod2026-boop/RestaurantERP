// notifications/types.js — the full catalogue of notification types the
// system can emit. A "type" is channel-agnostic: it just names an event.
// NotificationService decides at send-time which channel(s) actually
// deliver it, based on the restaurant's notificationSettings.
//
// Two families:
//  - REPORT types: scheduled digests (scheduler.js drives these)
//  - ALERT types: instant, event-driven (fired by watchers/scanners or
//    directly from a business module via NotificationService.send)
export const NOTIFICATION_TYPES = {
  // Reports (scheduled)
  DAILY_REPORT: "daily_report",
  WEEKLY_REPORT: "weekly_report",
  MONTHLY_REPORT: "monthly_report",
  SALES_REPORT: "sales_report",

  // Warehouse / production
  WAREHOUSE_ALERT: "warehouse_alert",
  LOW_STOCK: "low_stock",
  OUT_OF_STOCK: "out_of_stock",
  PRODUCTION_ALERT: "production_alert",

  // Staff
  EMPLOYEE_ATTENDANCE: "employee_attendance",
  LATE_EMPLOYEE: "late_employee",
  NEW_EMPLOYEE: "new_employee",

  // Customer-facing operations
  RESERVATION_ALERT: "reservation_alert",
  RESERVATION_CANCELLED: "reservation_cancelled",
  CUSTOMER_REVIEW: "customer_review",
  DELIVERY_PROBLEM: "delivery_problem",

  // System / commerce
  SYSTEM_ERROR: "system_error",
  SUBSCRIPTION_EXPIRATION: "subscription_expiration",
  BACKUP_COMPLETED: "backup_completed",
  LARGE_ORDER: "large_order",
  REFUND_ALERT: "refund_alert",
  FAILED_PAYMENT: "failed_payment",
  RESTAURANT_OFFLINE: "restaurant_offline",

  // Delivery lifecycle (migrated from the old telegram/bot.js TEMPLATES —
  // same 5 events, now routed through the generic service instead of being
  // hardcoded inside backend/delivery/engine.js).
  NEW_DELIVERY: "new_delivery",
  COURIER_ASSIGNED: "courier_assigned",
  COURIER_ARRIVED: "courier_arrived",
  PICKED_UP: "picked_up",
  DELIVERED: "delivered",
  DELIVERY_CANCELLED: "cancelled",

  // Additive — production notification system (2026 expansion)
  NEW_ORDER: "new_order",
  ORDER_CANCELLED: "order_cancelled",
  PAYMENT_RECEIVED: "payment_received",
  FOOD_SOLD_OUT: "food_sold_out",
  EMPLOYEE_LOGIN: "employee_login",
  EMPLOYEE_LOGOUT: "employee_logout",
  DATABASE_OFFLINE: "database_offline",
  PRINTER_OFFLINE: "printer_offline",

  // Additive — Telegram Control Panel (2026 expansion)
  KITCHEN_DELAY: "kitchen_delay",
  HIGH_REVENUE_MILESTONE: "high_revenue_milestone",
};

// Types shown as admin-toggleable checkboxes in Settings → Notifications.
// (Delivery-lifecycle types are always-on internal events, not user-facing
// checkboxes — they follow the "Yetkazib berish sozlamalari" telegramChatId
// that already existed before this module.)
export const TOGGLEABLE_TYPES = [
  NOTIFICATION_TYPES.DAILY_REPORT,
  NOTIFICATION_TYPES.WEEKLY_REPORT,
  NOTIFICATION_TYPES.MONTHLY_REPORT,
  NOTIFICATION_TYPES.SALES_REPORT,
  NOTIFICATION_TYPES.WAREHOUSE_ALERT,
  NOTIFICATION_TYPES.LOW_STOCK,
  NOTIFICATION_TYPES.OUT_OF_STOCK,
  NOTIFICATION_TYPES.PRODUCTION_ALERT,
  NOTIFICATION_TYPES.EMPLOYEE_ATTENDANCE,
  NOTIFICATION_TYPES.LATE_EMPLOYEE,
  NOTIFICATION_TYPES.RESERVATION_ALERT,
  NOTIFICATION_TYPES.RESERVATION_CANCELLED,
  NOTIFICATION_TYPES.CUSTOMER_REVIEW,
  NOTIFICATION_TYPES.DELIVERY_PROBLEM,
  NOTIFICATION_TYPES.SYSTEM_ERROR,
  NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRATION,
  NOTIFICATION_TYPES.BACKUP_COMPLETED,
  NOTIFICATION_TYPES.NEW_EMPLOYEE,
  NOTIFICATION_TYPES.LARGE_ORDER,
  NOTIFICATION_TYPES.REFUND_ALERT,
  NOTIFICATION_TYPES.FAILED_PAYMENT,
  NOTIFICATION_TYPES.NEW_ORDER,
  NOTIFICATION_TYPES.ORDER_CANCELLED,
  NOTIFICATION_TYPES.PAYMENT_RECEIVED,
  NOTIFICATION_TYPES.FOOD_SOLD_OUT,
  NOTIFICATION_TYPES.EMPLOYEE_LOGIN,
  NOTIFICATION_TYPES.EMPLOYEE_LOGOUT,
  NOTIFICATION_TYPES.DATABASE_OFFLINE,
  NOTIFICATION_TYPES.PRINTER_OFFLINE,
  NOTIFICATION_TYPES.KITCHEN_DELAY,
  NOTIFICATION_TYPES.HIGH_REVENUE_MILESTONE,
];

// Types that must fire immediately, bypassing any "digest"/batching —
// matches spec section 6 "Instant Alerts".
export const INSTANT_TYPES = new Set([
  NOTIFICATION_TYPES.WAREHOUSE_ALERT,
  NOTIFICATION_TYPES.LOW_STOCK,
  NOTIFICATION_TYPES.OUT_OF_STOCK,
  NOTIFICATION_TYPES.LARGE_ORDER,
  NOTIFICATION_TYPES.FAILED_PAYMENT,
  NOTIFICATION_TYPES.REFUND_ALERT,
  NOTIFICATION_TYPES.EMPLOYEE_ATTENDANCE,
  NOTIFICATION_TYPES.SYSTEM_ERROR,
  NOTIFICATION_TYPES.BACKUP_COMPLETED,
  NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRATION,
  NOTIFICATION_TYPES.RESTAURANT_OFFLINE,
  NOTIFICATION_TYPES.NEW_ORDER,
  NOTIFICATION_TYPES.ORDER_CANCELLED,
  NOTIFICATION_TYPES.RESERVATION_CANCELLED,
  NOTIFICATION_TYPES.PAYMENT_RECEIVED,
  NOTIFICATION_TYPES.FOOD_SOLD_OUT,
  NOTIFICATION_TYPES.COURIER_ARRIVED,
  NOTIFICATION_TYPES.DATABASE_OFFLINE,
  NOTIFICATION_TYPES.PRINTER_OFFLINE,
  NOTIFICATION_TYPES.KITCHEN_DELAY,
  NOTIFICATION_TYPES.HIGH_REVENUE_MILESTONE,
]);

// Coarse settings groups (spec section 11): "everything must respect
// Enable/Disable, Daily, Weekly, Monthly, Large order, Warehouse, Courier,
// Finance, System". Maps each fine-grained type to the group its checkbox
// visually belongs to in Settings → Notifications — purely a UI grouping
// aid, the actual gate is still the per-type `types[type]` flag.
export const TYPE_GROUPS = {
  [NOTIFICATION_TYPES.DAILY_REPORT]: "daily",
  [NOTIFICATION_TYPES.WEEKLY_REPORT]: "weekly",
  [NOTIFICATION_TYPES.MONTHLY_REPORT]: "monthly",
  [NOTIFICATION_TYPES.SALES_REPORT]: "finance",
  [NOTIFICATION_TYPES.LARGE_ORDER]: "large_order",
  [NOTIFICATION_TYPES.NEW_ORDER]: "large_order",
  [NOTIFICATION_TYPES.ORDER_CANCELLED]: "large_order",
  [NOTIFICATION_TYPES.WAREHOUSE_ALERT]: "warehouse",
  [NOTIFICATION_TYPES.LOW_STOCK]: "warehouse",
  [NOTIFICATION_TYPES.OUT_OF_STOCK]: "warehouse",
  [NOTIFICATION_TYPES.FOOD_SOLD_OUT]: "warehouse",
  [NOTIFICATION_TYPES.PRODUCTION_ALERT]: "warehouse",
  [NOTIFICATION_TYPES.DELIVERY_PROBLEM]: "courier",
  [NOTIFICATION_TYPES.REFUND_ALERT]: "finance",
  [NOTIFICATION_TYPES.FAILED_PAYMENT]: "finance",
  [NOTIFICATION_TYPES.PAYMENT_RECEIVED]: "finance",
  [NOTIFICATION_TYPES.SYSTEM_ERROR]: "system",
  [NOTIFICATION_TYPES.DATABASE_OFFLINE]: "system",
  [NOTIFICATION_TYPES.PRINTER_OFFLINE]: "system",
  [NOTIFICATION_TYPES.EMPLOYEE_LOGIN]: "system",
  [NOTIFICATION_TYPES.EMPLOYEE_LOGOUT]: "system",
};
