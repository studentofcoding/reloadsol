import AlgoTesterHub from "@/components/algo-tester/AlgoTesterHub";


export default function AlgoTesterPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Algo Tester</h1>
      <p className="mb-6 text-sm text-gray-400">
        Trending tracker dashboard and token tracking history.
      </p>
      <AlgoTesterHub />
    </div>
  );
}
