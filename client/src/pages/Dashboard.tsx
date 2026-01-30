import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Users, 
  Database, 
  Coins, 
  Trophy, 
  Bell, 
  Webhook, 
  Activity,
  Clock
} from "lucide-react";
import type { BotStatus, Creator, Token } from "@shared/schema";

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatMarketCap(mc: number): string {
  if (mc >= 1_000_000) {
    return `$${(mc / 1_000_000).toFixed(2)}M`;
  } else if (mc >= 1_000) {
    return `$${(mc / 1_000).toFixed(1)}K`;
  }
  return `$${mc.toFixed(0)}`;
}

function formatTimeAgo(timestamp: string | null): string {
  if (!timestamp) return "Never";
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatCard({ 
  title, 
  value, 
  icon: Icon, 
  description 
}: { 
  title: string; 
  value: string | number; 
  icon: React.ComponentType<{ className?: string }>; 
  description?: string;
}) {
  return (
    <Card data-testid={`card-stat-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ isOnline }: { isOnline: boolean }) {
  return (
    <Badge 
      variant={isOnline ? "default" : "destructive"}
      className="gap-1"
      data-testid="badge-bot-status"
    >
      <span className={`h-2 w-2 rounded-full ${isOnline ? 'bg-green-400' : 'bg-red-400'}`} />
      {isOnline ? "Online" : "Offline"}
    </Badge>
  );
}

export default function Dashboard() {
  const { data: status, isLoading: statusLoading } = useQuery<BotStatus>({
    queryKey: ["/api/status"],
    refetchInterval: 5000,
  });

  const { data: creators, isLoading: creatorsLoading } = useQuery<Creator[]>({
    queryKey: ["/api/creators/qualified"],
    refetchInterval: 30000,
  });

  const { data: recentTokens, isLoading: tokensLoading } = useQuery<Token[]>({
    queryKey: ["/api/tokens/recent"],
    refetchInterval: 10000,
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-md bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-lg">A</span>
              </div>
              <div>
                <h1 className="text-xl font-bold">Apex</h1>
                <p className="text-xs text-muted-foreground">PumpFun Creator Tracker</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {statusLoading ? (
                <Skeleton className="h-6 w-20" />
              ) : (
                <StatusBadge isOnline={status?.isOnline ?? false} />
              )}
              {status?.webhookRegistered && (
                <Badge variant="secondary" className="gap-1" data-testid="badge-webhook-status">
                  <Webhook className="h-3 w-3" />
                  Webhook Active
                </Badge>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
          {statusLoading ? (
            <>
              {[1, 2, 3, 4].map((i) => (
                <Card key={i}>
                  <CardHeader className="pb-2">
                    <Skeleton className="h-4 w-24" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-8 w-16" />
                  </CardContent>
                </Card>
              ))}
            </>
          ) : (
            <>
              <StatCard
                title="Total Users"
                value={status?.totalUsers ?? 0}
                icon={Users}
                description="Telegram subscribers"
              />
              <StatCard
                title="Total Creators"
                value={status?.totalCreators ?? 0}
                icon={Database}
                description={`${status?.qualifiedCreators ?? 0} qualified`}
              />
              <StatCard
                title="Tokens Tracked"
                value={status?.totalTokens ?? 0}
                icon={Coins}
              />
              <StatCard
                title="Alerts Sent"
                value={status?.alertsSentToday ?? 0}
                description={status?.alertStats?.failed ? `${status.alertStats.failed} failed` : undefined}
                icon={Bell}
              />
            </>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
          {statusLoading ? (
            <>
              {[1, 2, 3, 4].map((i) => (
                <Card key={i}>
                  <CardHeader className="pb-2">
                    <Skeleton className="h-4 w-24" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-8 w-16" />
                  </CardContent>
                </Card>
              ))}
            </>
          ) : (
            <>
              <StatCard
                title="Qualified Creators"
                value={status?.qualifiedCreators ?? 0}
                icon={Trophy}
                description="Meeting thresholds"
              />
              <StatCard
                title="Uptime"
                value={formatUptime(status?.uptime ?? 0)}
                icon={Clock}
              />
              <StatCard
                title="Last Webhook"
                value={formatTimeAgo(status?.lastWebhookReceived ?? null)}
                icon={Activity}
              />
              <StatCard
                title="Bot Status"
                value={status?.isOnline ? "Running" : "Stopped"}
                icon={Activity}
              />
            </>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card data-testid="card-qualified-creators">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Trophy className="h-5 w-5 text-primary" />
                Qualified Creators
              </CardTitle>
            </CardHeader>
            <CardContent>
              {creatorsLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : creators && creators.length > 0 ? (
                <div className="space-y-3">
                  {creators.slice(0, 5).map((creator) => (
                    <div
                      key={creator.address}
                      className="flex items-center justify-between p-3 rounded-md bg-muted/50 border"
                      data-testid={`creator-${creator.address.slice(0, 8)}`}
                    >
                      <div className="flex-1 min-w-0">
                        <code className="text-xs text-muted-foreground font-mono block truncate">
                          {creator.address}
                        </code>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="secondary" className="text-xs">
                            {creator.total_launches} launches
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {creator.bonded_count} bonded
                          </Badge>
                          {creator.hits_100k_count > 0 && (
                            <Badge className="text-xs">
                              {creator.hits_100k_count} x 100K+
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="text-right ml-2">
                        <div className="text-sm font-semibold">
                          {formatMarketCap(creator.best_mc_ever)}
                        </div>
                        <div className="text-xs text-muted-foreground">Best MC</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Trophy className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p>No qualified creators yet</p>
                  <p className="text-sm mt-1">Creators will appear here when they meet your thresholds</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-recent-tokens">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Coins className="h-5 w-5 text-primary" />
                Recent Tokens (24h)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {tokensLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : recentTokens && recentTokens.length > 0 ? (
                <div className="space-y-3">
                  {recentTokens.slice(0, 5).map((token) => (
                    <div
                      key={token.address}
                      className="flex items-center justify-between p-3 rounded-md bg-muted/50 border"
                      data-testid={`token-${token.address.slice(0, 8)}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">
                            ${token.symbol || "???"}
                          </span>
                          <span className="text-muted-foreground text-sm truncate">
                            {token.name || "Unknown"}
                          </span>
                        </div>
                        <code className="text-xs text-muted-foreground font-mono block truncate mt-1">
                          {token.address}
                        </code>
                      </div>
                      <div className="text-right ml-2">
                        <div className="text-sm font-semibold">
                          {formatMarketCap(token.peak_mc)}
                        </div>
                        <div className="flex items-center gap-1 justify-end">
                          {token.bonded === 1 && (
                            <Badge className="text-xs">Bonded</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Coins className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p>No recent tokens</p>
                  <p className="text-sm mt-1">Tokens from the last 24 hours will appear here</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6" data-testid="card-how-to-use">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="h-5 w-5 text-primary" />
              How to Use Apex
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="p-4 rounded-md bg-muted/50 border">
                <div className="font-semibold mb-2">1. Start the Bot</div>
                <p className="text-sm text-muted-foreground">
                  Open Telegram and search for your Apex bot. Send /start to begin.
                </p>
              </div>
              <div className="p-4 rounded-md bg-muted/50 border">
                <div className="font-semibold mb-2">2. Configure Settings</div>
                <p className="text-sm text-muted-foreground">
                  Use /settings to adjust your alert thresholds for bonded tokens and 100K+ MC hits.
                </p>
              </div>
              <div className="p-4 rounded-md bg-muted/50 border">
                <div className="font-semibold mb-2">3. Watch Creators</div>
                <p className="text-sm text-muted-foreground">
                  Use /watch &lt;address&gt; to add creators to your watchlist for priority alerts.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
