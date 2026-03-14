// Connects SearchableListView to the moltbot Worker backend.
// The Worker serves AI-generated Etsy product concepts organized by date.
import type {
  FindResourcesRequest,
  FindResourcesResponse,
} from "@canva/app-components";
import { auth } from "@canva/user";

// Injected by webpack DefinePlugin from .env — see webpack.config.js
declare const BACKEND_HOST: string;

/**
 * Called by SearchableListView whenever the user searches, navigates a folder,
 * or changes a filter. Forwards the request to our Worker's /dam/resources/find
 * endpoint, authenticated with the Canva user JWT.
 */
export async function findResources(
  request: FindResourcesRequest<"date_folder">,
): Promise<FindResourcesResponse> {
  // Canva issues a short-lived JWT identifying the current user.
  // Our Worker validates this token and uses it to scope the response.
  const userToken = await auth.getCanvaUserToken();

  const url = new URL(`${BACKEND_HOST}/dam/resources/find`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      console.error(`[dam] Backend error: ${response.status}`);
      return { type: "ERROR", errorCode: "INTERNAL_ERROR" };
    }

    const body = await response.json();

    if (body.resources) {
      return {
        type: "SUCCESS",
        resources: body.resources,
        continuation: body.continuation,
      };
    }

    return { type: "ERROR", errorCode: body.errorCode ?? "INTERNAL_ERROR" };
  } catch (err) {
    console.error("[dam] Network error:", err);
    return { type: "ERROR", errorCode: "INTERNAL_ERROR" };
  }
}
