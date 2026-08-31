import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { data, type LoaderFunctionArgs } from "react-router";
import { TUTORIAL_PAGES } from "~/lib/tutorial-steps";
import {
  startTutorialFromBeginning,
  startTutorialAtPage,
  resumeTutorial,
  isTutorialCompleted,
  markTutorialCompleted,
} from "~/components/TutorialProvider";
import { useTranslation } from "react-i18next";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data({});
};

export default function TutorialPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    setCompleted(isTutorialCompleted());
  }, []);

  const handleStart = () => {
    startTutorialFromBeginning();
    navigate(TUTORIAL_PAGES[0].route);
  };

  const handleResume = () => {
    const page = resumeTutorial();
    if (page) navigate(page);
  };

  const handleRestart = () => {
    markTutorialCompleted();
    startTutorialFromBeginning();
    navigate(TUTORIAL_PAGES[0].route);
  };

  const handleGoToPage = (page: typeof TUTORIAL_PAGES[number]) => {
    startTutorialAtPage(page.id);
    navigate(page.route);
  };

  return (
    <Page
      title={t('tutorial.title')}
      backAction={{ content: t('nav.dashboard'), onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              {t('tutorial.subtitle')}
            </Text>
            <Text variant="bodyMd" as="p">
              {t('tutorial.description')}
            </Text>

            {completed && (
              <Badge tone="success">{t('tutorial.completed')}</Badge>
            )}

            <InlineStack gap="300" align="start">
              <Button
                variant="primary"
                onClick={completed ? handleResume : handleStart}
              >
                {completed ? t('tutorial.continue') : t('tutorial.start')}
              </Button>
              {completed && (
                <Button onClick={handleRestart}>
                  {t('tutorial.restart')}
                </Button>
              )}
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              {t('tutorial.sections')}
            </Text>
            <Text variant="bodyMd" as="p">
              {t('tutorial.sectionsDescription')}
            </Text>

            <BlockStack gap="300">
              {TUTORIAL_PAGES.map((page, i) => (
                <InlineStack key={page.id} align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Badge>{String(i + 1)}</Badge>
                    <Text variant="bodyMd" fontWeight="semibold" as="span">
                      {t(page.label)}
                    </Text>
                  </InlineStack>
                  <Button
                    size="slim"
                    onClick={() => handleGoToPage(page)}
                  >
                    {t('tutorial.goTo')}
                  </Button>
                </InlineStack>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              {t('tutorial.tips')}
            </Text>
            <BlockStack gap="200">
              <Text variant="bodyMd" as="p">
                {t('tutorial.tipReactive')}
              </Text>
              <Text variant="bodyMd" as="p">
                {t('tutorial.tipNavigation')}
              </Text>
              <Text variant="bodyMd" as="p">
                {t('tutorial.tipAutoAdvance')}
              </Text>
              <Text variant="bodyMd" as="p">
                {t('tutorial.tipExit')}
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
