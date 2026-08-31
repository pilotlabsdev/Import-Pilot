import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { useActionData, Form, useLoaderData } from "react-router";
import { useState } from "react";
import {
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { login } from "~/shopify.server";

const ERROR_MESSAGES: Record<string, string> = {
  MISSING_SHOP: "Introduce el dominio de la tienda",
  INVALID_SHOP: "El dominio de la tienda no es válido",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = await login(request);
  return data({ errors });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = await login(request);
  return data({ errors });
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errorKey = actionData?.errors?.shop || loaderData?.errors?.shop || "";
  const error = errorKey ? ERROR_MESSAGES[errorKey] : "";
  const [shop, setShop] = useState("");

  return (
    <Page>
      <Card>
        <Form method="post">
          <FormLayout>
            <Text variant="headingMd" as="h2">
              Login
            </Text>
            <TextField
              type="text"
              name="shop"
              label="Shop domain"
              helpText="e.g: my-shop-domain.myshopify.com"
              value={shop}
              onChange={setShop}
              autoComplete="on"
              error={error || undefined}
            />
            <Button submit variant="primary">
              Submit
            </Button>
          </FormLayout>
        </Form>
      </Card>
    </Page>
  );
}