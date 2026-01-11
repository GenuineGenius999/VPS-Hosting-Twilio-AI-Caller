import dotenv from "dotenv";

dotenv.config();

// Configuration from environment variables
const CUSTOMER_API_URL = process.env.CUSTOMER_API_URL || "https://5lcxmffj-4000.inc1.devtunnels.ms/api/v1/org/customers";
const LOGIN_API_URL = process.env.LOGIN_API_URL || "https://5lcxmffj-4000.inc1.devtunnels.ms/api/v1/auth/login";
const CUSTOMER_API_EMAIL = process.env.CUSTOMER_API_EMAIL || "";
const CUSTOMER_API_PASSWORD = process.env.CUSTOMER_API_PASSWORD || "";
const CUSTOMER_ORG_ID = process.env.CUSTOMER_ORG_ID || "11111111-1111-1111-1111-111111111111";

// Token cache structure
interface TokenCache {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
  orgId: string;
}

// In-memory token cache
let tokenCache: TokenCache | null = null;

/**
 * Login to the API and obtain access token
 * @returns Token cache object or null if login fails
 */
async function login(): Promise<TokenCache | null> {
  // Check if credentials are configured
  if (!CUSTOMER_API_EMAIL || !CUSTOMER_API_PASSWORD) {
    console.error("❌ Customer API credentials not configured. Set CUSTOMER_API_EMAIL and CUSTOMER_API_PASSWORD in .env");
    return null;
  }

  try {
    const response = await fetch(LOGIN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        identifier: CUSTOMER_API_EMAIL,
        password: CUSTOMER_API_PASSWORD
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error("❌ Login failed:", {
        status: response.status,
        statusText: response.statusText,
        error: errorText
      });
      return null;
    }

    const data = await response.json();
    
    // Extract token information from response
    // Based on the image, the response structure is: { data: { accessToken, expiresin, refreshToken, org: { orgId } } }
    const accessToken = data?.data?.accessToken;
    const refreshToken = data?.data?.refreshToken;
    const expiresIn = data?.data?.expiresin || 900; // Default to 900 seconds (15 minutes)
    const orgId = data?.data?.org?.orgId || CUSTOMER_ORG_ID;

    if (!accessToken) {
      console.error("❌ Login response missing accessToken");
      return null;
    }

    // Calculate expiration time (subtract 60 seconds for safety margin)
    const expiresAt = Date.now() + (expiresIn - 60) * 1000;

    const tokenData: TokenCache = {
      accessToken,
      refreshToken: refreshToken || "",
      expiresAt,
      orgId
    };

    console.log("✅ Successfully logged in and obtained access token");
    return tokenData;
  } catch (error: any) {
    console.error("❌ Error during login:", error.message);
    return null;
  }
}

/**
 * Initialize customer API authentication by obtaining an access token
 * This should be called when the server starts up
 * @returns Promise that resolves when initialization is complete (success or failure)
 */
export async function initializeCustomerAPI(): Promise<void> {
  // Check if credentials are configured
  if (!CUSTOMER_API_EMAIL || !CUSTOMER_API_PASSWORD) {
    console.log("⚠️  Customer API credentials not configured. Customer registration will be skipped.");
    console.log("   Set CUSTOMER_API_EMAIL and CUSTOMER_API_PASSWORD in .env to enable customer registration.");
    return;
  }

  console.log("🔄 Initializing customer API authentication...");
  const newTokenCache = await login();

  if (newTokenCache) {
    tokenCache = newTokenCache;
    console.log("✅ Customer API authentication initialized successfully");
  } else {
    console.error("❌ Failed to initialize customer API authentication. Customer registration may not work.");
  }
}

/**
 * Get a valid access token, refreshing if necessary
 * @returns Access token string or null if unavailable
 */
async function getAccessToken(): Promise<string | null> {
  const now = Date.now();

  // Check if we have a valid cached token
  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.accessToken;
  }

  // Token expired or doesn't exist, login again
  console.log("🔄 Token expired or missing, logging in...");
  const newTokenCache = await login();

  if (!newTokenCache) {
    return null;
  }

  // Update cache
  tokenCache = newTokenCache;
  return tokenCache.accessToken;
}

/**
 * Register a customer in the external API system asynchronously
 * This function fires and forgets - it doesn't block the caller
 * 
 * @param phoneNumber - The phone number from Twilio (used for both email and phone fields)
 */
export async function registerCustomer(phoneNumber: string): Promise<void> {
  // Skip if no phone number provided
  if (!phoneNumber) {
    console.log("⚠️  Skipping customer registration: No phone number provided");
    return;
  }

  // Get access token dynamically
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("⚠️  Skipping customer registration: Unable to obtain access token");
    return;
  }

  // Use orgId from token cache if available, otherwise fall back to env variable
  const orgId = tokenCache?.orgId || CUSTOMER_ORG_ID;

  // Build customer data payload
  const customerData = {
    email: phoneNumber+"@gmail.com", // Use phone number as email
    metadata: {
      additionalProp1: "string",
      additionalProp2: "string",
      additionalProp3: "string"
    },
    name: "Acme Corporation", // Default name
    orgId: orgId,
    phone: phoneNumber, // Use the phone number from Twilio
    status: "active",
    tags: [
      "vip",
      "enterprise"
    ]
  };
  console.log(customerData,"customerData");

  try {
    // Make POST request to customer API
    const response = await fetch(CUSTOMER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive"
      },
      body: JSON.stringify(customerData)
    });

    if (response.ok) {
      console.log(`✅ Customer registered successfully for phone: ${phoneNumber}`);
    } else {
      // If we get a 401, the token might be invalid, try to refresh
      if (response.status === 401) {
        console.log("🔄 Received 401, clearing token cache and retrying...");
        tokenCache = null; // Clear cache
        const newToken = await getAccessToken();
        
        if (newToken) {
          // Retry the request with new token
          const retryResponse = await fetch(CUSTOMER_API_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${newToken}`,
              "Content-Type": "application/json",
              "Accept": "application/json",
              "Accept-Encoding": "gzip, deflate, br",
              "Connection": "keep-alive"
            },
            body: JSON.stringify(customerData)
          });

          if (retryResponse.ok) {
            console.log(`✅ Customer registered successfully for phone: ${phoneNumber} (after token refresh)`);
            return;
          }
        }
      }

      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`❌ Customer registration failed for phone ${phoneNumber}:`, {
        status: response.status,
        statusText: response.statusText,
        error: errorText
      });
    }
  } catch (error: any) {
    // Log error but don't throw - we want this to be fire-and-forget
    console.error(`❌ Error registering customer for phone ${phoneNumber}:`, error.message);
  }
}

/**
 * Fire-and-forget version that doesn't return a promise
 * This ensures the function runs asynchronously without blocking
 * 
 * @param phoneNumber - The phone number from Twilio
 */
export function registerCustomerAsync(phoneNumber: string): void {
  // Call the async function but don't await it
  // This ensures it runs in the background without blocking
  registerCustomer(phoneNumber).catch((error) => {
    // Additional error handling for any unhandled rejections
    console.error("Unhandled error in customer registration:", error);
  });
}
