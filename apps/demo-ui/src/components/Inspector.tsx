import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WordButton } from "@/components/ui/word-button";
import { setStatsOpen } from "../lib/statsPanel.js";
import { EventsTab } from "./EventsTab.js";
import { ProofTab } from "./ProofTab.js";
import { VerifierLane } from "./VerifierLane.js";
import { WorkerLane } from "./WorkerLane.js";

/** Technical detail on demand. Proof: hashes and signatures (plus the live worker and verifier lanes). Events: raw messages. */
export function Inspector({ mock }: { mock: boolean }) {
  return (
    <Tabs defaultValue="proof" className="gap-4">
      <TabsList className="w-full">
        <TabsTrigger value="proof">Proof</TabsTrigger>
        <TabsTrigger value="events">Events</TabsTrigger>
      </TabsList>
      <WordButton onClick={() => setStatsOpen(true)} className="justify-self-start">
        Stats of all verifier runs (s)
      </WordButton>
      <TabsContent value="proof" className="grid gap-6">
        <ProofTab />
        {!mock && <WorkerLane />}
        {!mock && <VerifierLane />}
      </TabsContent>
      <TabsContent value="events">
        <EventsTab />
      </TabsContent>
    </Tabs>
  );
}
