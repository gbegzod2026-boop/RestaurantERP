// rbac-helpers.js
//
// Reusable, named permission helpers for the Admin Panel RBAC system.
// Every piece of UI (sidebar, buttons, table columns/action menus, section
// guards) must go through these instead of re-reading window._rbacModules /
// window._rbacActions directly, so there is exactly one place permission
// logic lives.
//
// Backing state (window._rbacModules / window._rbacActions / window._isSuperAdmin)
// is populated and kept live (via Firebase onValue listeners, no caching) by
// admin.js's listenRbacPermissions()/resolveRoleConfig(). This file only reads
// that state — it never fetches or stores permissions itself.
//
// FUTURE MODULES: adding a new module needs no change here. Just:
//   1) add its id to ALL_MODULES (admin.js) and to the relevant role
//      template(s) / let it be assignable via custom roles,
//   2) tag its buttons with data-rbac-module="newmodule" data-rbac-action="...",
//   3) call gateActionsIn(container, "newmodule") after rendering it.

/** True if the current user's role grants access to the given module at all (View). */
export function hasModule(moduleId) {
  if (window._isSuperAdmin) return true;
  if (!window._rbacModules) return true; // owner / unrestricted
  return window._rbacModules.includes(moduleId);
}

function hasAction(moduleId, action) {
  if (window._isSuperAdmin) return true;
  if (!hasModule(moduleId)) return false;
  return window.hasRbacAction ? window.hasRbacAction(moduleId, action) : true;
}

export function canView(moduleId) { return hasAction(moduleId, "view"); }
export function canCreate(moduleId) { return hasAction(moduleId, "create"); }
export function canEdit(moduleId) { return hasAction(moduleId, "edit"); }
export function canDelete(moduleId) { return hasAction(moduleId, "delete"); }
export function canExport(moduleId) { return hasAction(moduleId, "export"); }
export function canRefund(moduleId) { return hasAction(moduleId, "refund"); }
export function canDiscount(moduleId) { return hasAction(moduleId, "discount"); }
// "Manage Permissions" is stored internally as the "manage_roles" action key.
export function canManagePermissions(moduleId) { return hasAction(moduleId, "manage_roles"); }

// Exposed on window as well, since most of admin.js is a classic (non-module)
// script and can't `import` this file — it includes rbac-helpers.js as a
// <script type="module"> and reads these off window.
window.hasModule = hasModule;
window.canView = canView;
window.canCreate = canCreate;
window.canEdit = canEdit;
window.canDelete = canDelete;
window.canExport = canExport;
window.canRefund = canRefund;
window.canDiscount = canDiscount;
window.canManagePermissions = canManagePermissions;
