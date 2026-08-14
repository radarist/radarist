import { SharedRadarClientWrapper } from "./SharedRadarClientWrapper";

/**
 * Server Component for the shared radar page.
 * It receives the `radarId` from the route parameters and passes it to the client-side wrapper.
 *
 * @param props - Page props.
 * @param props.params - Promise resolving to route parameters.
 * @returns The client wrapper component.
 */
export default async function SharedRadarPage({ params }: { params: Promise<{ radarId: string }> }) {
    const { radarId } = await params;

    return <SharedRadarClientWrapper radarId={radarId} />;
}
