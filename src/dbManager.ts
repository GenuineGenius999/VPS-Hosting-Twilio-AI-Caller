import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

// Database configuration from environment variables
const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Connection pool settings
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
};

// Validate required environment variables
if (!dbConfig.host || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
  throw new Error(
    "Missing required database environment variables: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD"
  );
}

// Create a connection pool
const pool = new Pool(dbConfig);

// Handle pool errors
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

// Test database connection
export async function connectDatabase(): Promise<void> {
  try {
    const client = await pool.connect();
    console.log("✅ Successfully connected to PostgreSQL database");
    console.log(`   Host: ${dbConfig.host}:${dbConfig.port}`);
    console.log(`   Database: ${dbConfig.database}`);
    console.log(`   User: ${dbConfig.user}`);
    
    // Test query to verify connection
    const result = await client.query("SELECT NOW()");
    console.log(`   Connection test successful. Server time: ${result.rows[0].now}`);
    
    client.release();
  } catch (error) {
    console.error("❌ Failed to connect to PostgreSQL database:", error);
    throw error;
  }
}

// Execute a query using the pool
export async function query(text: string, params?: any[]): Promise<any> {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log("Executed query", { text, duration, rows: result.rowCount });
    return result;
  } catch (error) {
    console.error("Database query error:", error);
    throw error;
  }
}

// Get a client from the pool for transactions
export async function getClient(): Promise<PoolClient> {
  return await pool.connect();
}

// Close all connections in the pool
export async function closePool(): Promise<void> {
  await pool.end();
  console.log("Database connection pool closed");
}

// Export the pool for advanced usage
export { pool };

// Database operations for conversation table
export const conversationDB = {
  // Insert a new conversation
  async insert(
    companyPhone: string,
    callerPhone: string,
    status: string,
    context: string | null = null,
    conversationId: string
  ): Promise<any> {
    const text = `
      INSERT INTO conversation (company_phone, caller_phone, speaker, transcription, conversation_id, conversation_time)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    const values = [companyPhone, callerPhone, status, context, conversationId];
    const result = await query(text, values);
    return result.rows[0];
  },

  // Get conversation by ID
  async getById(id: number): Promise<any> {
    const text = `SELECT * FROM conversation WHERE id = $1`;
    const result = await query(text, [id]);
    return result.rows[0];
  },

  // Get conversations by caller phone
  async getByCallerPhone(callerPhone: string): Promise<any[]> {
    const text = `SELECT * FROM conversation WHERE caller_phone = $1 ORDER BY call_time DESC`;
    const result = await query(text, [callerPhone]);
    return result.rows;
  },

  // Get conversations by company phone
  async getByCompanyPhone(companyPhone: string): Promise<any[]> {
    const text = `SELECT * FROM conversation WHERE company_phone = $1 ORDER BY conversation_time DESC`;
    const result = await query(text, [companyPhone]);
    return result.rows;
  },

  // Update conversation status
  async updateStatus(id: number, status: string): Promise<any> {
    const text = `UPDATE conversation SET status = $1 WHERE id = $2 RETURNING *`;
    const result = await query(text, [status, id]);
    return result.rows[0];
  },

  // Update conversation context
  async updateContext(id: number, context: string): Promise<any> {
    const text = `UPDATE conversation SET context = $1 WHERE id = $2 RETURNING *`;
    const result = await query(text, [context, id]);
    return result.rows[0];
  },

  // Get all conversations
  async getAll(limit: number = 100): Promise<any[]> {
    const text = `SELECT * FROM conversation ORDER BY conversation_time DESC LIMIT $1`;
    const result = await query(text, [limit]);
    return result.rows;
  },

  // Get paginated conversations by caller phone number
  async getPaginatedByCallerPhone(
    callerPhone: string,
    page: number = 1,
    limit: number = 10
  ): Promise<{ conversations: any[]; total: number; page: number; limit: number; totalPages: number }> {
    const offset = (page - 1) * limit;
    
    // Phone should already be normalized by the route handler
    // But try a few variations as fallback (with/without +, with space)
    const phoneVariations = [
      callerPhone,                                    // Normalized phone (should work)
      callerPhone.replace(/^\+/, ' ').trim(),        // With space instead of + (in case DB has this)
      callerPhone.startsWith('+') ? callerPhone.substring(1) : callerPhone, // Without +
    ].filter((phone, index, self) => self.indexOf(phone) === index && phone.length > 0);
    
    // Build WHERE clause with OR conditions for phone variations
    const conditions = phoneVariations.map((_, idx) => `caller_phone = $${idx + 1}`).join(' OR ');
    
    // Get total count
    const countText = `SELECT COUNT(*) FROM conversation WHERE ${conditions}`;
    const countResult = await query(countText, phoneVariations);
    const total = parseInt(countResult.rows[0].count);
    
    // Get paginated conversations
    const paramCount = phoneVariations.length;
    const dataText = `
      SELECT * FROM conversation 
      WHERE ${conditions}
      ORDER BY conversation_time DESC 
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;
    const dataParams = [...phoneVariations, limit, offset];
    const dataResult = await query(dataText, dataParams);
    
    const totalPages = Math.ceil(total / limit);
    
    return {
      conversations: dataResult.rows,
      total,
      page,
      limit,
      totalPages,
    };
  },

  // Get paginated conversations by both caller phone and company phone
  async getPaginatedByCallerAndCompanyPhone(
    callerPhone: string,
    companyPhone: string,
    page: number = 1,
    limit: number = 10
  ): Promise<{ conversations: any[]; total: number; page: number; limit: number; totalPages: number }> {
    const offset = (page - 1) * limit;
    
    // Generate phone variations for caller phone
    const callerPhoneVariations = [
      callerPhone,                                    // Normalized phone (should work)
      callerPhone.replace(/^\+/, ' ').trim(),        // With space instead of + (in case DB has this)
      callerPhone.startsWith('+') ? callerPhone.substring(1) : callerPhone, // Without +
    ].filter((phone, index, self) => self.indexOf(phone) === index && phone.length > 0);
    
    // Generate phone variations for company phone
    const companyPhoneVariations = [
      companyPhone,                                    // Normalized phone (should work)
      companyPhone.replace(/^\+/, ' ').trim(),        // With space instead of + (in case DB has this)
      companyPhone.startsWith('+') ? companyPhone.substring(1) : companyPhone, // Without +
    ].filter((phone, index, self) => self.indexOf(phone) === index && phone.length > 0);
    
    // Build WHERE clause with AND conditions for both phones
    // Each phone can match any of its variations
    const callerConditions = callerPhoneVariations
      .map((_, idx) => `caller_phone = $${idx + 1}`)
      .join(' OR ');
    
    const companyParamOffset = callerPhoneVariations.length;
    const companyConditions = companyPhoneVariations
      .map((_, idx) => `company_phone = $${companyParamOffset + idx + 1}`)
      .join(' OR ');
    
    const whereClause = `(${callerConditions}) AND (${companyConditions})`;
    
    // Get total count
    const countText = `SELECT COUNT(*) FROM conversation WHERE ${whereClause}`;
    const countParams = [...callerPhoneVariations, ...companyPhoneVariations];
    const countResult = await query(countText, countParams);
    const total = parseInt(countResult.rows[0].count);
    
    // Get paginated conversations
    const paramCount = countParams.length;
    const dataText = `
      SELECT * FROM conversation 
      WHERE ${whereClause}
      ORDER BY conversation_time DESC 
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;
    const dataParams = [...countParams, limit, offset];
    const dataResult = await query(dataText, dataParams);
    
    const totalPages = Math.ceil(total / limit);
    
    return {
      conversations: dataResult.rows,
      total,
      page,
      limit,
      totalPages,
    };
  },
};
