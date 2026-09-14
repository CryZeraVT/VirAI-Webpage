(() => {
  "use strict";

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const candidate = String(fragment.get("access_token") || "");
  const token = candidate.length >= 10 && candidate.length <= 2048 && !/\s/.test(candidate)
    ? candidate
    : "";

  // OAuth fragments are not sent to the web server, but browsers retain them
  // in history. Remove the fragment before rendering or handling user input.
  try {
    history.replaceState({}, document.title, window.location.pathname);
  } catch {
    // Token still remains outside the DOM; history cleanup can fail on file:// previews.
  }

  const tokenElement = document.getElementById("token");
  const copyButton = document.getElementById("copy-token");
  const copiedMessage = document.getElementById("copied");

  if (!token) {
    tokenElement.className = "error";
    tokenElement.textContent = "❌ No valid token found. Please connect again from Viri.TTS Settings.";
    copyButton.disabled = true;
    return;
  }

  // Keep the credential out of the DOM; it is available only inside this
  // closure until the page is closed or refreshed.
  tokenElement.textContent = "Token ready — copy it into Viri.TTS.";

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(token);
      copiedMessage.style.display = "flex";
      window.setTimeout(() => {
        copiedMessage.style.display = "none";
      }, 3000);
    } catch {
      alert("Clipboard access was blocked. Allow clipboard access, then click Copy Token again.");
    }
  });
})();
