import "package:photos/events/event.dart";

class DeviceChargingChangedEvent extends Event {
  final bool isCharging;

  DeviceChargingChangedEvent(this.isCharging);
}
