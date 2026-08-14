'use client';

import Link from 'next/link';
import { MoreVertical, LogOut, Settings as SettingsIcon, Loader2 } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useAuth } from '@/components/providers/AuthProvider';
import { useOwnerProfile } from '@/hooks/useOwnerProfile';

export function NavUser({
  user: fallbackUser,
}: {
  user: {
    name: string;
    email: string;
    avatar: string;
  };
}) {
  const { isMobile } = useSidebar();
  const { user: authUser, loading: authLoading, signOut } = useAuth();
  const { data: ownerProfile } = useOwnerProfile();

  // UX-062: bind the visible identity to the canonical owner profile FIRST,
  // then the Firebase Auth identity. The Auth `displayName` is intentionally
  // NOT the primary source — the seed stamps `Radarist Demo User` onto it, so
  // it is not a trustworthy signal of the actual authenticated account. The
  // owner profile (`users/{uid}`) is authoritative; when it is absent (a fresh
  // signup that has not been seeded) the verified email username is the
  // reliable real-identity fallback. The verified email is always shown.
  const user = authUser
    ? {
        name:
          ownerProfile?.displayName ??
          authUser.displayName ??
          authUser.email?.split('@')[0] ??
          'User',
        email: authUser.email ?? ownerProfile?.email ?? '',
        avatar: ownerProfile?.photoURL ?? authUser.photoURL ?? '',
      }
    : fallbackUser;

  // Retained reload: Firebase auth-state restoration is asynchronous. Until it
  // resolves, render a neutral loading state so a stale demo label or the
  // branding fallback can never flash for the wrong account.
  if (authLoading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" className="pointer-events-none opacity-70">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium text-muted-foreground">Loading…</span>
              <span className="truncate text-xs text-muted-foreground">Restoring session</span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg grayscale">
                <AvatarImage src={user.avatar} alt={user.name} />
                <AvatarFallback className="rounded-lg">{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </div>
              <MoreVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-lg">{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {/* DISC-004: was a silent no-op item; now routes to Settings. The
                  dead "Notifications" item was removed — no dedicated
                  notifications surface exists to link to.
                  UX-047: labeled "Settings" to match where it actually goes —
                  /settings has no account tab, so "Account" named a page the
                  app doesn't have. */}
              <DropdownMenuItem asChild className="cursor-pointer">
                <Link href="/settings">
                  <SettingsIcon />
                  Settings
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut} className="cursor-pointer">
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
