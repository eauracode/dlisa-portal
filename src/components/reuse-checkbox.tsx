/** Staff message forms: whether this answer may be given instantly to students who ask the same thing. */
export function ReuseCheckbox({ defaultChecked, personal = false }: { defaultChecked: boolean; personal?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="hidden" name="reuseShown" value="1" />
      <input type="checkbox" name="reusable" defaultChecked={defaultChecked} className="mt-1 h-4 w-4 shrink-0 accent-brand-600" />
      <span>
        Reuse as an instant answer
        <span className="block text-xs text-muted">
          Students who later ask the same thing get this reply straight away.
          {personal && " Leave unticked if it mentions this student's own details."}
        </span>
      </span>
    </label>
  );
}
