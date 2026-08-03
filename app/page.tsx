import { redirect } from 'next/navigation';

/** Product entry is the Wasm harness — no separate playground route. */
export default function Home() {
  redirect('/harness');
}
