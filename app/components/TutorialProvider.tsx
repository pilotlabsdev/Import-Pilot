import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { getPageSteps, TUTORIAL_PAGES } from "~/lib/tutorial-steps";
import { Button, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

const STORAGE_KEY = "app-tutorial-state";
const COMPLETED_KEY = "app-tutorial-done";
const HIGHLIGHT_CLASS = "app-tutorial-highlight";

interface TutorialState {
  active: boolean;
  pageIndex: number;
}

function getState(): TutorialState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.active && typeof parsed.pageIndex === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveState(state: TutorialState | null) {
  if (state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function detectPage(pathname: string): string | null {
  if (pathname === "/app" || pathname === "/app/" || pathname.includes("/tutorial/dashboard")) return "dashboard";
  if (pathname.includes("/tutorial/supplier/")) {
    if (pathname.includes("/import")) return "import";
    if (pathname.includes("/config")) return "config";
    if (pathname.includes("/columns")) return "columns";
    if (pathname.includes("/price-rules")) return "price-rules";
    if (pathname.includes("/category-mapping")) return "category-mapping";
    if (pathname.includes("/preview")) return "preview";
    if (pathname.includes("/logs")) return "logs";
    return "import";
  }
  if (pathname.includes("/tutorial/settings")) return "settings";
  if (pathname.includes("/tutorial/duplicates")) return "duplicates";
  if (pathname.endsWith("/tutorial") || pathname.endsWith("/tutorial/")) return null;
  if (pathname.includes("/settings")) return "settings";
  if (pathname.includes("/duplicates")) return "duplicates";
  if (pathname.includes("/queue")) return "queue";
  if (pathname.includes("/supplier/")) {
    if (pathname.includes("/import")) return "import";
    if (pathname.includes("/config")) return "config";
    if (pathname.includes("/columns")) return "columns";
    if (pathname.includes("/price-rules")) return "price-rules";
    if (pathname.includes("/category-mapping")) return "category-mapping";
    if (pathname.includes("/preview")) return "preview";
    if (pathname.includes("/logs")) return "logs";
    return "import";
  }
  return "dashboard";
}

function TourTooltip({
  steps,
  currentStep,
  onNext,
  onPrev,
  onExit,
  isLastPage,
}: {
  steps: any[];
  currentStep: number;
  onNext: () => void;
  onPrev: () => void;
  onExit: () => void;
  isLastPage: boolean;
}) {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 20, left: 20 });
  const ref = useRef<HTMLDivElement>(null);
  const highlightedRef = useRef<Element | null>(null);
  const step = steps[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === steps.length - 1;
  const { t } = useTranslation();

  useEffect(() => {
    if (highlightedRef.current) {
      highlightedRef.current.classList.remove(HIGHLIGHT_CLASS);
      highlightedRef.current = null;
    }

    if (!step) return;

    const timer = setTimeout(() => {
      try {
        const el = document.querySelector(step.selector);
        if (el) {
          el.classList.add(HIGHLIGHT_CLASS);
          highlightedRef.current = el;
        }
      } catch {}
    }, 100);

    return () => {
      clearTimeout(timer);
      if (highlightedRef.current) {
        highlightedRef.current.classList.remove(HIGHLIGHT_CLASS);
        highlightedRef.current = null;
      }
    };
  }, [step]);

  useEffect(() => {
    function calc() {
      if (!step) return;
      try {
        const el = document.querySelector(step.selector);
        if (!el || !ref.current) {
          setPos({ top: 20, left: 20 });
          return;
        }

        const rect = el.getBoundingClientRect();
        const inViewport = rect.top >= 0 && rect.bottom <= window.innerHeight;
        if (!inViewport) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }

        const tipH = ref.current.offsetHeight || 150;
        const tipW = ref.current.offsetWidth || 360;
        const viewportH = window.innerHeight;
        const viewportW = window.innerWidth;
        const MARGIN = 16;

        const newRect = el.getBoundingClientRect();
        let top = newRect.bottom + MARGIN;
        let left = newRect.left + newRect.width / 2 - tipW / 2;

        if (left < MARGIN) left = MARGIN;
        if (left + tipW > viewportW - MARGIN) left = viewportW - tipW - MARGIN;

        if (top + tipH > viewportH - MARGIN) {
          top = newRect.top - tipH - MARGIN;
        }
        if (top < MARGIN) {
          top = MARGIN;
        }

        setPos({ top, left });
      } catch {
        setPos({ top: 20, left: 20 });
      }
    }
    calc();
    const id = setInterval(calc, 200);
    return () => clearInterval(id);
  }, [step]);

  if (!step) return null;

  const overlay = (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 99999,
          background: "transparent",
          pointerEvents: "none",
        }}
      />
      <div
        ref={ref}
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          zIndex: 100001,
          background: "#fff",
          borderRadius: "8px",
          boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
          padding: "16px",
          maxWidth: "360px",
          width: "360px",
          border: "1px solid #e1e3e5",
        }}
      >
        <BlockStack gap="300">
          {typeof step.content === "string" ? (
            <Text variant="bodyMd" as="p">{step.content}</Text>
          ) : (
            step.content
          )}

          <InlineStack align="space-between" blockAlign="center">
            <Text variant="bodySm" tone="subdued" as="span">
              {currentStep + 1} / {steps.length}
            </Text>

            <InlineStack gap="200">
              <Button size="slim" onClick={onExit}>
                {t("common.exit")}
              </Button>
              {!isFirst && (
                <Button size="slim" onClick={onPrev}>
                  {t("common.previous")}
                </Button>
              )}
              <Button
                size="slim"
                variant="primary"
                onClick={onNext}
              >
                {isLast
                  ? isLastPage
                    ? t("common.finish")
                    : t("common.next")
                  : t("common.next")}
              </Button>
            </InlineStack>
          </InlineStack>
        </BlockStack>
      </div>
    </>
  );

  return createPortal(overlay, document.body);
}

function TourController() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [tourSteps, setTourSteps] = useState<any[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const pageIndexRef = useRef(0);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);

  useEffect(() => {
    const state = getState();
    if (!state || !state.active) {
      setIsOpen(false);
      return;
    }

    const currentPageId = TUTORIAL_PAGES[state.pageIndex]?.id;
    if (!currentPageId) {
      saveState(null);
      setIsOpen(false);
      return;
    }

    const detected = detectPage(location.pathname);
    if (!detected || detected !== currentPageId) {
      setIsOpen(false);
      return;
    }

    const allSteps = getPageSteps(currentPageId).map((s) => ({
      selector: s.element,
      content: (
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">
            {t(s.title)}
          </Text>
          <Text variant="bodyMd" as="p" tone="subdued">
            {t(s.description)}
          </Text>
        </BlockStack>
      ),
    }));

    const steps = allSteps.filter((s) => {
      try {
        return !!document.querySelector(s.selector);
      } catch {
        return false;
      }
    });

    if (steps.length === 0) {
      const nextIdx = state.pageIndex + 1;
      if (nextIdx < TUTORIAL_PAGES.length) {
        saveState({ active: true, pageIndex: nextIdx });
        navigate(TUTORIAL_PAGES[nextIdx].route);
      } else {
        saveState(null);
        localStorage.setItem(COMPLETED_KEY, "true");
        navigate("/app/tutorial");
      }
      return;
    }

    setTourSteps(steps);
    setCurrentStep(0);
    setPageIndex(state.pageIndex);

    const timer = setTimeout(() => {
      setIsOpen(true);
    }, 500);

    return () => {
      clearTimeout(timer);
    };
  }, [location.pathname, location.search]);

  const handleNext = useCallback(() => {
    const next = currentStep + 1;
    if (next >= tourSteps.length) {
      const currentPageIdx = pageIndexRef.current;
      const nextPageIdx = currentPageIdx + 1;
      if (nextPageIdx < TUTORIAL_PAGES.length) {
        saveState({ active: true, pageIndex: nextPageIdx });
        navigate(TUTORIAL_PAGES[nextPageIdx].route);
      } else {
        saveState(null);
        localStorage.setItem(COMPLETED_KEY, "true");
        setIsOpen(false);
        navigate("/app/tutorial");
      }
    } else {
      setCurrentStep(next);
    }
  }, [currentStep, tourSteps, navigate]);

  const handlePrev = useCallback(() => {
    const prev = Math.max(0, currentStep - 1);
    setCurrentStep(prev);
  }, [currentStep]);

  const handleExit = useCallback(() => {
    saveState(null);
    setIsOpen(false);
    navigate("/app/tutorial");
  }, [navigate]);

  if (!isOpen || tourSteps.length === 0) return null;

  const isLastPage = pageIndex === TUTORIAL_PAGES.length - 1;

  return (
    <TourTooltip
      steps={tourSteps}
      currentStep={currentStep}
      onNext={handleNext}
      onPrev={handlePrev}
      onExit={handleExit}
      isLastPage={isLastPage}
    />
  );
}

export function TutorialProvider({ children }: { children: ReactNode }) {
  return (
    <>
      <TourController />
      {children}
    </>
  );
}

export function startTutorialFromBeginning() {
  saveState({ active: true, pageIndex: 0 });
}

export function startTutorialAtPage(pageId: string) {
  const idx = TUTORIAL_PAGES.findIndex((p) => p.id === pageId);
  saveState({ active: true, pageIndex: idx >= 0 ? idx : 0 });
}

export function resumeTutorial(): string | null {
  const state = getState();
  if (state && state.active && state.pageIndex < TUTORIAL_PAGES.length) {
    return TUTORIAL_PAGES[state.pageIndex].route;
  }
  return null;
}

export function stopTutorial() {
  saveState(null);
}

export function isTutorialCompleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

export function markTutorialCompleted() {
  localStorage.setItem(COMPLETED_KEY, "true");
  saveState(null);
}
