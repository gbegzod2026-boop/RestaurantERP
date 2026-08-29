import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool, withTenantContext } from "../postgres.js";
import * as pathRouter from "../../pg/pathRouter.js";

const REST = `rest_${Date.now()}`;

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("pg-extended-paths.test.mjs", available.error);
} else {
  test("plan, attendance, announcement, and chat paths use PostgreSQL", async () => {
    const pool = getPool();
    const setup = await pool.connect();
    let restaurantId;
    try {
      restaurantId = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id, info)
         VALUES ($1, 'Extended paths', $2,
                 '{"tariff":"pro","subscription":{"features":["kds"],"customFeatures":["+finance"]}}'::jsonb)
         RETURNING id`,
        [`extended-${Date.now()}.local`, REST]
      )).rows[0].id;
      await setup.query(
        `INSERT INTO employees
          (restaurant_id, name, login, role, legacy_rtdb_id, active, extra)
         VALUES ($1, 'Chef', 'extended_chef', 'chef', 'chef_1', true, '{}'::jsonb)`,
        [restaurantId]
      );

      const result = await withTenantContext(restaurantId, async (client) => {
        const ctx = {
          restaurantUuid: restaurantId,
          restId: REST,
          userId: "chef_1",
          actingRole: "owner",
        };
        const events = [];
        const date = "2026-08-28";
        const info = await pathRouter.rtdbGet(client, ctx, `restaurants/${REST}/info/tariff`);
        const subscription = await pathRouter.rtdbGet(client, ctx, `restaurants/${REST}/subscription`);

        await pathRouter.rtdbUpdate(
          client, ctx, `restaurants/${REST}/attendance/${date}/chef_1`,
          { status: "present", onlineAt: Date.now(), lastSeen: Date.now() }, events
        );
        const attendance = await pathRouter.rtdbGet(
          client, ctx, `restaurants/${REST}/attendance/${date}/chef_1`
        );

        const announcement = await pathRouter.rtdbPush(
          client, ctx, `restaurants/${REST}/kitchenAnnouncements/${date}`,
          { text: "Service starts", authorId: "chef_1", createdAt: Date.now(), readBy: {} }, events
        );
        const announcements = await pathRouter.rtdbGet(
          client, ctx, `restaurants/${REST}/kitchenAnnouncements/${date}`
        );

        const chat = await pathRouter.rtdbPush(
          client, ctx, `restaurants/${REST}/chats/admin_chef_chef_1/messages`,
          { text: "Ready", senderId: "chef_1", senderRole: "chef", createdAt: Date.now() }, events
        );
        const messages = await pathRouter.rtdbGet(
          client, ctx, `restaurants/${REST}/chats/admin_chef_chef_1/messages`
        );

        const superadminChat = await pathRouter.rtdbPush(
          client, ctx, `restaurants/${REST}/superadmin_chat`,
          { text: "Support", sender: "admin", timestamp: Date.now() }, events
        );
        const supportMessages = await pathRouter.rtdbGet(
          client, ctx, `restaurants/${REST}/superadmin_chat`
        );

        const forbiddenConfigWrite = await pathRouter.rtdbSet(
          client, ctx, `restaurants/${REST}/subscription/features`, ["all"], events
        );
        return {
          info, subscription, attendance, announcement, announcements,
          chat, messages, superadminChat, supportMessages, forbiddenConfigWrite,
          events,
        };
      }, { actingRole: "owner" });

      assert.equal(result.info.value, "pro");
      assert.deepEqual(result.subscription.value.features, ["kds"]);
      assert.equal(result.attendance.value.status, "present");
      assert.ok(result.announcements.value[result.announcement.key]);
      assert.equal(result.messages.value[result.chat.key].text, "Ready");
      assert.equal(result.supportMessages.value[result.superadminChat.key].text, "Support");
      assert.equal(result.forbiddenConfigWrite.code, "unmapped_path");
      assert.ok(result.events.length >= 4);
    } finally {
      if (restaurantId) await setup.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]).catch(() => {});
      setup.release();
      await closePool();
    }
  });
}
