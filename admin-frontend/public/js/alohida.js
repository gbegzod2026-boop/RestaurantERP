const SOCKET_URL =
  localStorage.getItem("socketUrl") ||
  document.documentElement.dataset.socketUrl ||
  window.location.origin;

const socket = typeof io === "function"
  ? io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    })
  : null;

function updateClientOrderStatusUI(orderId, status) {
  const directStatus = document.querySelector(`#order-${orderId} .status`);
  if (directStatus) {
    directStatus.textContent = status;
  }

  const cardStatus = document.querySelector(`[data-order='${orderId}'] .order-status`);
  if (cardStatus) {
    cardStatus.textContent = status;
  }
}

function sendOrderToKitchen(orderData) {
  if (!socket) {
    console.warn("Socket.io client is not available on this page.");
    return;
  }

  const orderId = orderData?.orderId || `order_${Date.now()}`;
  socket.emit("new-order", {
    orderId,
    order: orderData,
  });
}

function handleOrderStatusUpdate(data) {
  if (!data?.orderId && !data?.id) {
    return;
  }

  const orderId = data.orderId || data.id;
  updateClientOrderStatusUI(orderId, data.status);
}

if (socket) {
  socket.on("connect", () => {
    console.log("Socket.io connected:", socket.id);
  });

  socket.on("connect_error", (err) => {
    console.error("Socket connection error:", err);
  });

  socket.on("order-status-update", handleOrderStatusUpdate);
  socket.on("orderStatusUpdate", handleOrderStatusUpdate);
}

window.sendOrderToKitchen = sendOrderToKitchen;
window.updateClientOrderStatusUI = updateClientOrderStatusUI;
