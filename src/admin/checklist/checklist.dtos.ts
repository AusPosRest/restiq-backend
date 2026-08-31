import { IsBoolean } from 'class-validator'

// CAP-2's five checklist steps. Each is a column on checklist_progress
// today; stories 2 (outlet_details), 5 (floor_plan), 5/CAP-3 (menu_import),
// 6 (devices) and 7 (staff) call PATCH /admin/v1/checklist/:step from their
// own flows once their feature exists - this module derives none of them.
export const CHECKLIST_STEPS = ['outlet_details', 'floor_plan', 'menu_import', 'devices', 'staff'] as const
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number]

export class UpdateChecklistStepDto {
  @IsBoolean()
  completed!: boolean
}
