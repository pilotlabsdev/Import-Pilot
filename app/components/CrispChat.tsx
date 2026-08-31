import { useEffect } from "react";
import { Crisp } from "crisp-sdk-web";

const CRISP_WEBSITE_ID = "17eefac6-102f-4837-91c7-7c5652bf941a";

let initialized = false;

export function CrispChat({ shopDomain }: { shopDomain?: string }) {
  useEffect(() => {
    if (!initialized) {
      Crisp.configure(CRISP_WEBSITE_ID);
      Crisp.load();
      initialized = true;
    }

    if (shopDomain) {
      Crisp.user.setCompany(shopDomain, { url: `https://${shopDomain}` });
    }
  }, [shopDomain]);

  return null;
}
