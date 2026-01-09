import { Request, Response } from "express";
import { conversationDB } from "./dbManager";

/**
 * GET /api/conversations/history
 * Retrieve paginated conversation history for a phone number
 * 
 * Query parameters:
 * - callerPhone: The caller's phone number to retrieve conversations for (required)
 * - companyPhone: The company's phone number to filter by (required)
 * - page: Page number (default: 1)
 * - limit: Number of messages per page (default: 10)
 */
/**
 * Normalize phone number for database queries
 * Handles URL encoding issues where + sign becomes space in URLs
 * In URL query strings, + is interpreted as space unless encoded as %2B
 * Express automatically decodes %2B to +, but if + isn't encoded, it becomes space
 */
function normalizePhoneNumber(phone: string): string {
  // Express already decodes query parameters, but we need to handle cases where
  // + was sent without encoding (which becomes space in URLs)
  
  // Critical fix: If phone starts with a space followed by digits,
  // it means + was converted to space during URL parsing
  // Example: +12702017480 in URL -> " 12702017480" when decoded
  if (/^\s+[0-9]/.test(phone)) {
    // Replace leading space(s) with + sign
    phone = phone.replace(/^\s+/, '+');
  }
  
  // Remove all spaces (leading, middle, trailing) to normalize
  // The + sign is now preserved if it was there or if we just added it
  const normalized = phone.replace(/\s/g, '');
  
  return normalized.trim();
}

export async function getConversationHistory(req: Request, res: Response): Promise<void> {
  try {
    let { callerPhone, companyPhone, page: pageParam, limit: limitParam } = req.query;

    // Validate required parameters
    if (!callerPhone || typeof callerPhone !== "string") {
      res.status(400).json({
        status: "error",
        statusCode: 400,
        message: "Missing or invalid 'callerPhone' parameter. Caller phone number is required.",
        error: "VALIDATION_ERROR",
      });
      return;
    }

    if (!companyPhone || typeof companyPhone !== "string") {
      res.status(400).json({
        status: "error",
        statusCode: 400,
        message: "Missing or invalid 'companyPhone' parameter. Company phone number is required.",
        error: "VALIDATION_ERROR",
      });
      return;
    }

    // Normalize phone numbers to handle URL encoding issues
    callerPhone = normalizePhoneNumber(callerPhone);
    companyPhone = normalizePhoneNumber(companyPhone);

    // Parse and validate page parameter
    const page = pageParam ? parseInt(pageParam as string, 10) : 1;
    if (isNaN(page) || page < 1) {
      res.status(400).json({
        status: "error",
        statusCode: 400,
        message: "Invalid 'page' parameter. Must be a positive integer.",
        error: "VALIDATION_ERROR",
      });
      return;
    }

    // Parse and validate limit parameter
    const limit = limitParam ? parseInt(limitParam as string, 10) : 10;
    if (isNaN(limit) || limit < 1 || limit > 100) {
      res.status(400).json({
        status: "error",
        statusCode: 400,
        message: "Invalid 'limit' parameter. Must be between 1 and 100.",
        error: "VALIDATION_ERROR",
      });
      return;
    }

    // Get conversations filtered by both caller phone and company phone
    let result = await conversationDB.getPaginatedByCallerAndCompanyPhone(
      callerPhone,
      companyPhone,
      page,
      limit
    );

    // Return paginated results in enterprise API format
    res.status(200).json({
      status: "success",
      statusCode: 200,
      message: "Conversation history retrieved successfully",
      data: {
        items: result.conversations,
        page: result.page,
        pageSize: result.limit,
        total: result.total,
      },
    });
  } catch (error: any) {
    console.error("Error fetching conversation history:", error);
    res.status(500).json({
      status: "error",
      statusCode: 500,
      message: error.message || "Failed to retrieve conversation history",
      error: "INTERNAL_SERVER_ERROR",
    });
  }
}
