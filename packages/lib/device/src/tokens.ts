import type { SubsystemToken } from "@koi/core";
import { token } from "@koi/core";
import type {
  CameraComponent,
  ContactsComponent,
  LocationSensorComponent,
  MotionSensorComponent,
  PushChannelComponent,
  SmsChannelComponent,
} from "./types.js";

export const LOCATION: SubsystemToken<LocationSensorComponent> =
  token<LocationSensorComponent>("sensor:location");
export const MOTION: SubsystemToken<MotionSensorComponent> =
  token<MotionSensorComponent>("sensor:motion");
export const SMS: SubsystemToken<SmsChannelComponent> = token<SmsChannelComponent>("channel:sms");
export const PUSH: SubsystemToken<PushChannelComponent> =
  token<PushChannelComponent>("channel:push");
export const CAMERA: SubsystemToken<CameraComponent> = token<CameraComponent>("tool:camera");
export const CONTACTS: SubsystemToken<ContactsComponent> =
  token<ContactsComponent>("tool:contacts");
