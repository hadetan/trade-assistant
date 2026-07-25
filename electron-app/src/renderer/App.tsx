import { useEffect, useState } from "react";
import type { AppStatus, BannerEvent, RendererApi } from "../main/ipc/rendererApi";

function bridge(): RendererApi {
  return (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [banners, setBanners] = useState<BannerEvent[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    void bridge()
      .getStatus()
      .then(setStatus);
    bridge().onBanner((banner) => setBanners((prev) => [...prev, banner]));
  }, []);

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true);
    setLoginError(null);
    const result = await bridge().login();
    setLoggingIn(false);
    if (result.status === "authenticated") setStatus(await bridge().getStatus());
    else setLoginError(result.message);
  };

  const authenticated = status?.kiteSession === "authenticated";

  return (
    <main className="app">
      <h1>Trade Assistant</h1>
      <div className="status">
        {status ? `sidecar: ${status.sidecar} | kite: ${status.kiteSession}` : "Loading…"}
      </div>
      <ul className="banners">
        {banners.map((banner, index) => (
          <li key={index}>
            [{banner.kind}] {banner.message}
          </li>
        ))}
      </ul>
      {!authenticated && (
        <button type="button" onClick={onLogin} disabled={loggingIn}>
          {loggingIn ? "Logging in…" : "Login to Kite"}
        </button>
      )}
      {loginError && <div className="error">{loginError}</div>}
    </main>
  );
}
