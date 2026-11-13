const params = new URLSearchParams(window.location.search);
const targetUrl = params.get("target");

if (targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    document.getElementById("blocked-url").textContent = parsed.hostname;
  } catch (e) {
    document.getElementById("blocked-url").textContent = targetUrl;
  }
} else {
  document.getElementById("blocked-url").textContent = "Restricted Site";
}