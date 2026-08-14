"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"
import { type ThemeProviderProps } from "next-themes/dist/types"

/**
 * Wrapper around `next-themes` ThemeProvider.
 * Enables dark/light mode switching throughout the application.
 *
 * @param props - ThemeProvider props.
 * @returns The provider wrapper.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
