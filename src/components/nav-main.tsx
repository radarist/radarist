'use client';

import * as React from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useMemo } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';

export function NavMain({
  items,
}: {
  items: {
    title: string;
    url: string;
    icon?: LucideIcon;
    isActive?: boolean;
    items?: {
      title: string;
      url: string;
      badge?: React.ReactNode;
    }[];
  }[];
}) {
  const pathname = usePathname();

  // Compute initial open state synchronously to avoid hydration mismatch
  const initialOpenItems = useMemo(() => {
    const result: Record<string, boolean> = {};
    items.forEach((item) => {
      if (item.items && item.items.length > 0) {
        const isChildActive = item.items.some((subItem) => pathname.startsWith(subItem.url));
        const isParentActive = pathname === item.url || pathname.startsWith(item.url + '/');
        result[item.title] = isChildActive || isParentActive || item.isActive || false;
      }
    });
    return result;
  }, [pathname, items]);

  // Track user interactions separately from initial state
  const [userOverrides, setUserOverrides] = useState<Record<string, boolean>>({});

  // Merge initial state with user overrides
  const openItems = useMemo(
    () => ({
      ...initialOpenItems,
      ...userOverrides,
    }),
    [initialOpenItems, userOverrides]
  );

  const handleOpenChange = (title: string, isOpen: boolean) => {
    setUserOverrides((prev) => ({ ...prev, [title]: isOpen }));
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Platform</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) =>
          item.items && item.items.length > 0 ? (
            // Collapsible parent with children
            <Collapsible
              key={item.title}
              asChild
              open={openItems[item.title] ?? item.isActive ?? false}
              onOpenChange={(isOpen) => handleOpenChange(item.title, isOpen)}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton tooltip={item.title}>
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                    <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items.map((subItem) => (
                      <SidebarMenuSubItem key={subItem.title}>
                        <SidebarMenuSubButton
                          asChild
                          isActive={
                            subItem.url === item.url ? pathname === subItem.url : pathname.startsWith(subItem.url)
                          }
                        >
                          <Link href={subItem.url}>
                            <span>{subItem.title}</span>
                            {subItem.badge}
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          ) : (
            // Standalone item (no children)
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton tooltip={item.title} asChild isActive={pathname === item.url}>
                <Link href={item.url}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
