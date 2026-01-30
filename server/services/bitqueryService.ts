import { logger } from "../utils/logger";

const BITQUERY_API_URL = "https://streaming.bitquery.io/graphql";
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

interface BitqueryToken {
  mint: string;
  signature: string;
  timestamp: string;
}

interface BitqueryResponse {
  data?: {
    Solana?: {
      Instructions?: Array<{
        Transaction: {
          Signature: string;
        };
        Instruction: {
          Accounts: Array<{ Address: string }>;
        };
        Block: {
          Time: string;
        };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export async function fetchCreatorTokenHistory(
  creatorAddress: string,
  limit: number = 1000
): Promise<{ tokens: BitqueryToken[]; totalCount: number }> {
  const apiKey = process.env.BITQUERY_API_KEY;
  
  if (!apiKey) {
    logger.warn("BITQUERY_API_KEY not set, skipping historical import");
    return { tokens: [], totalCount: 0 };
  }

  const query = `
    query GetCreatorTokens($creator: String!, $limit: Int!) {
      Solana {
        Instructions(
          where: {
            Instruction: {
              Program: {
                Address: {is: "${PUMPFUN_PROGRAM_ID}"}
              }
            }
            Transaction: {
              Signer: {is: $creator}
            }
          }
          orderBy: {descending: Block_Time}
          limit: {count: $limit}
        ) {
          Transaction {
            Signature
          }
          Instruction {
            Accounts {
              Address
            }
          }
          Block {
            Time
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(BITQUERY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        query,
        variables: {
          creator: creatorAddress,
          limit,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`Bitquery API error ${response.status}: ${text}`);
      return { tokens: [], totalCount: 0 };
    }

    const result: BitqueryResponse = await response.json();

    if (result.errors && result.errors.length > 0) {
      logger.error("Bitquery GraphQL errors:", result.errors[0].message);
      return { tokens: [], totalCount: 0 };
    }

    const instructions = result.data?.Solana?.Instructions || [];
    
    const tokens: BitqueryToken[] = instructions
      .filter(inst => {
        const accounts = inst.Instruction?.Accounts || [];
        // The mint address is typically the 3rd account in PumpFun create instruction
        const mintAccount = accounts[2]?.Address;
        return mintAccount && mintAccount.toLowerCase().endsWith("pump");
      })
      .map(inst => {
        const accounts = inst.Instruction?.Accounts || [];
        return {
          mint: accounts[2]?.Address || "",
          signature: inst.Transaction?.Signature || "",
          timestamp: inst.Block?.Time || "",
        };
      });

    logger.info(`Bitquery: Found ${tokens.length} tokens for creator ${creatorAddress.slice(0, 8)}...`);
    
    return {
      tokens,
      totalCount: tokens.length,
    };
  } catch (error: any) {
    logger.error("Bitquery fetch error:", error.message);
    return { tokens: [], totalCount: 0 };
  }
}

export async function getCreatorLaunchCount(creatorAddress: string): Promise<number> {
  const apiKey = process.env.BITQUERY_API_KEY;
  
  if (!apiKey) {
    return 0;
  }

  const query = `
    query GetCreatorLaunchCount($creator: String!) {
      Solana {
        Instructions(
          where: {
            Instruction: {
              Program: {
                Address: {is: "${PUMPFUN_PROGRAM_ID}"}
              }
            }
            Transaction: {
              Signer: {is: $creator}
            }
          }
        ) {
          count
        }
      }
    }
  `;

  try {
    const response = await fetch(BITQUERY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        query,
        variables: {
          creator: creatorAddress,
        },
      }),
    });

    if (!response.ok) {
      return 0;
    }

    const result = await response.json();
    return result.data?.Solana?.Instructions?.[0]?.count || 0;
  } catch (error) {
    return 0;
  }
}
