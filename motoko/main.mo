import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Int "mo:core/Int";
import Text "mo:core/Text";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Runtime "mo:core/Runtime";
import Result "mo:core/Result";
import Admin "mo:thebes-lib/Admin";

persistent actor BookingSystem {
  type Service = {
    id : Nat;
    name : Text;
    durationMinutes : Nat;
    priceCents : Nat;
    // Pointer to the service photo on the media contract (e.g. "/photo/{hash}").
    // Image bytes live in the media contract; this stores only the pointer.
    photoPath : ?Text;
  };

  type Booking = {
    id : Nat;
    serviceId : Nat;
    slotId : Nat;
    slotStart : Int;
    customer : Principal;
    createdAt : Int;
  };

  // A generated time slot for a service. `booked` carries the booking id once
  // taken; null means free. Storing the booking id (not just a Bool) lets a
  // cancellation re-open the exact slot.
  type Slot = {
    id : Nat;
    serviceId : Nat;
    startNs : Int;
    booked : ?Nat;
  };

  var nextServiceId : Nat = 0;
  var nextBookingId : Nat = 0;
  var nextSlotId : Nat = 0;

  // Services: id -> service
  let services = Map.empty<Nat, Service>();

  // Bookings: id -> booking
  let bookings = Map.empty<Nat, Booking>();

  // Slots: slot id -> slot
  let slots = Map.empty<Nat, Slot>();

  // Customer bookings: customer -> [booking_id]
  let customerBookings = Map.empty<Principal, [Nat]>();

  // Standard admin surface (lib/Admin): owner claim/transfer, admins tier,
  // emergency-stop pause. One stable var holds the whole admin state.
  var admin = Admin.init();

  public shared(msg) func claimOwner() : async Bool { Admin.claimOwner(admin, msg.caller) };
  public shared(msg) func transferOwner(n : Principal) : async Bool { Admin.transferOwner(admin, msg.caller, n) };
  public shared(msg) func addAdmin(w : Principal) : async Bool { Admin.addAdmin(admin, msg.caller, w) };
  public shared(msg) func removeAdmin(w : Principal) : async Bool { Admin.removeAdmin(admin, msg.caller, w) };
  public shared(msg) func setPaused(v : Bool) : async Bool { Admin.setPaused(admin, msg.caller, v) };
  public query func getOwner() : async ?Principal { Admin.getOwner(admin) };
  public query func getAdmins() : async [Principal] { Admin.getAdmins(admin) };
  public query func isPaused() : async Bool { Admin.isPaused(admin) };

  // Admin tier (owner or granted admins) — closed by default until claimed.
  private func isOwnerOrAdmin(caller : Principal) : Bool {
    Admin.isAdmin(admin, caller);
  };

  // No-auth raw insert (shared by the gated entrypoint and seedDemo).
  private func addServiceRaw(name : Text, durationMinutes : Nat, priceCents : Nat, photoPath : ?Text) : Nat {
    let id = nextServiceId;
    nextServiceId += 1;
    Map.add(services, Nat.compare, id, { id; name; durationMinutes; priceCents; photoPath });
    id;
  };

  private func doAddService(caller : Principal, name : Text, durationMinutes : Nat, priceCents : Nat, photoPath : ?Text) : Result.Result<Nat, Text> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) { return #err("Not authorized") };
    #ok(addServiceRaw(name, durationMinutes, priceCents, photoPath));
  };

  // Owner-gated: only the business owner may register services.
  public shared(msg) func addService(name : Text, durationMinutes : Nat, priceCents : Nat, photoPath : ?Text) : async Result.Result<Nat, Text> {
    doAddService(msg.caller, name, durationMinutes, priceCents, photoPath);
  };

  // Trap-on-error variant for the frontend: returns the id on success and traps
  // the error (e.g. "Not authorized") so it surfaces as a failed call.
  public shared(msg) func addServiceOrTrap(name : Text, durationMinutes : Nat, priceCents : Nat, photoPath : ?Text) : async Nat {
    switch (doAddService(msg.caller, name, durationMinutes, priceCents, photoPath)) {
      case (#ok id) { id }; case (#err e) { Runtime.trap(e) };
    };
  };

  private func doSetServicePhoto(caller : Principal, serviceId : Nat, photoPath : Text) : Result.Result<(), Text> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) { return #err("Not authorized") };
    switch (Map.get(services, Nat.compare, serviceId)) {
      case null { #err("Service not found") };
      case (?service) {
        Map.add(services, Nat.compare, serviceId, { service with photoPath = ?photoPath });
        #ok(());
      };
    };
  };

  // Owner-gated: set/replace a service's photo (uploaded to the media contract
  // first → "/photo/{hash}").
  public shared(msg) func setServicePhoto(serviceId : Nat, photoPath : Text) : async Result.Result<(), Text> {
    doSetServicePhoto(msg.caller, serviceId, photoPath);
  };
  public shared(msg) func setServicePhotoOrTrap(serviceId : Nat, photoPath : Text) : async () {
    switch (doSetServicePhoto(msg.caller, serviceId, photoPath)) { case (#ok _) {}; case (#err e) { Runtime.trap(e) } };
  };

  public query func getServices() : async [Service] {
    Iter.toArray(Map.values(services));
  };

  // Owner-gated: generate concrete bookable slots for a service across the
  // [startTime, endTime) window, one every `intervalMinutes`. Each slot is
  // stored individually so availability and double-booking can be checked O(1).
  // No-auth raw slot generation (shared by the gated entrypoint and seedDemo).
  // Assumes the window/interval have already been validated.
  private func createSlotsRaw(serviceId : Nat, startTime : Int, endTime : Int, intervalMinutes : Nat) : Nat {
    let stepNs : Int = intervalMinutes * 60 * 1_000_000_000;
    var cursor : Int = startTime;
    var created : Nat = 0;
    while (cursor < endTime) {
      let slotId = nextSlotId;
      nextSlotId += 1;
      Map.add(slots, Nat.compare, slotId, { id = slotId; serviceId; startNs = cursor; booked = null });
      created += 1;
      cursor += stepNs;
    };
    created;
  };

  private func doCreateSlots(caller : Principal, serviceId : Nat, startTime : Int, endTime : Int, intervalMinutes : Nat) : Result.Result<Nat, Text> {
    Admin.requireNotPaused(admin);
    if (not isOwnerOrAdmin(caller)) { return #err("Not authorized") };
    if (Map.get(services, Nat.compare, serviceId) == null) { return #err("Service not found") };
    if (intervalMinutes == 0) { return #err("Interval must be greater than zero") };
    if (endTime <= startTime) { return #err("End time must be after start time") };
    #ok(createSlotsRaw(serviceId, startTime, endTime, intervalMinutes));
  };

  public shared(msg) func createSlots(serviceId : Nat, startTime : Int, endTime : Int, intervalMinutes : Nat) : async Result.Result<Nat, Text> {
    doCreateSlots(msg.caller, serviceId, startTime, endTime, intervalMinutes);
  };
  public shared(msg) func createSlotsOrTrap(serviceId : Nat, startTime : Int, endTime : Int, intervalMinutes : Nat) : async Nat {
    switch (doCreateSlots(msg.caller, serviceId, startTime, endTime, intervalMinutes)) {
      case (#ok n) { n }; case (#err e) { Runtime.trap(e) };
    };
  };

  // Free, future slots for a service, ascending by start. Booked and elapsed
  // slots are excluded. Returns the slot RECORDS (id + startNs) so a client can
  // book by `id` — returning bare start times would make the slot unbookable.
  public query func getAvailableSlots(serviceId : Nat) : async [Slot] {
    let now = Time.now();
    let allSlots = Iter.toArray(Map.values(slots));
    let free = Array.filter(allSlots, func(s : Slot) : Bool {
      s.serviceId == serviceId and s.booked == null and s.startNs >= now;
    });
    Array.sort(free, func(a : Slot, b : Slot) : { #less; #equal; #greater } {
      Int.compare(a.startNs, b.startNs);
    });
  };

  // Books a specific generated slot. Double-booking is prevented by checking
  // the slot's `booked` field and atomically (same call, no awaits in between)
  // marking it taken while creating the booking.
  // Core booking over an explicit caller (synchronous — the double-booking guard
  // is atomic, no await between the check and the writes). Shared by the
  // Result-returning `bookAppointment` and the trap-wrapping `bookAppointmentOrTrap`.
  private func doBook(caller : Principal, slotId : Nat) : Result.Result<Nat, Text> {
    Admin.requireNotPaused(admin);
    switch (Map.get(slots, Nat.compare, slotId)) {
      case null { #err("Slot not found") };
      case (?slot) {
        // Reject if the slot is already taken — this is the double-booking guard.
        switch (slot.booked) {
          case (?_) { return #err("Slot already booked") };
          case null {};
        };
        switch (Map.get(services, Nat.compare, slot.serviceId)) {
          case null { #err("Service not found") };
          case (?_service) {
            let bookingId = nextBookingId;
            nextBookingId += 1;

            let booking : Booking = {
              id = bookingId;
              serviceId = slot.serviceId;
              slotId = slotId;
              slotStart = slot.startNs;
              customer = caller;
              createdAt = Time.now();
            };

            Map.add(bookings, Nat.compare, bookingId, booking);

            // Mark the slot booked in the same synchronous step as creating the
            // booking — no `await` separates these writes, so two concurrent
            // callers cannot both observe the slot as free.
            let takenSlot : Slot = { slot with booked = ?bookingId };
            Map.add(slots, Nat.compare, slotId, takenSlot);

            // Index the booking under the customer.
            let existingBookings = switch (Map.get(customerBookings, Principal.compare, caller)) {
              case (?b) { b };
              case null { [] };
            };
            let newBookings = Array.concat([bookingId], existingBookings);
            Map.add(customerBookings, Principal.compare, caller, newBookings);

            #ok(bookingId);
          };
        };
      };
    };
  };

  public shared(msg) func bookAppointment(slotId : Nat) : async Result.Result<Nat, Text> { doBook(msg.caller, slotId) };

  // Frontend-friendly: returns the new booking id, or traps with the reason
  // (e.g. "Slot already booked") so the SPA gets a clean value or typed error.
  public shared(msg) func bookAppointmentOrTrap(slotId : Nat) : async Nat {
    switch (doBook(msg.caller, slotId)) { case (#ok(id)) { id }; case (#err(e)) { Runtime.trap(e) } };
  };

  public shared(msg) func cancelBooking(bookingId : Nat) : async Result.Result<(), Text> {
    Admin.requireNotPaused(admin);
    switch (Map.get(bookings, Nat.compare, bookingId)) {
      case null { #err("Booking not found") };
      case (?booking) {
        if (booking.customer != msg.caller) {
          return #err("Not authorized");
        };

        ignore Map.take(bookings, Nat.compare, bookingId);

        // Re-open the slot so it can be booked again.
        switch (Map.get(slots, Nat.compare, booking.slotId)) {
          case (?slot) {
            let freedSlot : Slot = { slot with booked = null };
            Map.add(slots, Nat.compare, booking.slotId, freedSlot);
          };
          case null {};
        };

        // Remove from customer's bookings.
        let existingBookings = switch (Map.get(customerBookings, Principal.compare, msg.caller)) {
          case (?b) { b };
          case null { return #ok(()) };
        };

        let filteredBookings = Array.filter(existingBookings, func(bid : Nat) : Bool { bid != bookingId });
        Map.add(customerBookings, Principal.compare, msg.caller, filteredBookings);

        #ok(());
      };
    };
  };

  // Returns the caller's own upcoming bookings (slotStart in the future),
  // ascending by start time. `query(msg)` exposes msg.caller so each caller
  // sees only their identity's bookings — no hardcoded principal.
  public shared query(msg) func getMyBookings() : async [Booking] {
    let now = Time.now();
    let myIds = switch (Map.get(customerBookings, Principal.compare, msg.caller)) {
      case (?ids) { ids };
      case null { return []; };
    };

    let myBookings = Array.map(myIds, func(id : Nat) : Booking {
      switch (Map.get(bookings, Nat.compare, id)) {
        case (?b) { b };
        case null { Runtime.trap("Missing booking " # Nat.toText(id)); };
      };
    });

    let upcoming = Array.filter(myBookings, func(b : Booking) : Bool { b.slotStart >= now });
    Array.sort(upcoming, func(a : Booking, b : Booking) : { #less; #equal; #greater } {
      Int.compare(a.slotStart, b.slotStart);
    });
  };

  // Owner-gated: all bookings whose slot falls within [dayStartNs, dayEndNs),
  // oldest-first by slot start. Lets the owner pull a day's schedule.
  public shared query(msg) func getSchedule(dayStartNs : Int, dayEndNs : Int) : async [Booking] {
    if (not isOwnerOrAdmin(msg.caller)) {
      return [];
    };
    let allBookings = Iter.toArray(Map.values(bookings));
    let inWindow = Array.filter(allBookings, func(b : Booking) : Bool {
      b.slotStart >= dayStartNs and b.slotStart < dayEndNs;
    });
    Array.sort(inWindow, func(a : Booking, b : Booking) : { #less; #equal; #greater } {
      Int.compare(a.slotStart, b.slotStart);
    });
  };

  // Populate a fresh deploy with a few reservable listings + bookable future
  // slots, so the catalog looks alive on first load. Global content, idempotent:
  // a no-op (returns false) once any listing exists. Bypasses the owner gate
  // intentionally — it only fires on an empty, just-deployed contract, so the
  // first visitor can bring the demo to life.
  public shared(msg) func seedDemo() : async Bool {
    Admin.requireNotPaused(admin);
    if (Principal.isAnonymous(msg.caller)) Runtime.trap("anonymous caller");
    if (Map.size(services) > 0) return false;
    let now = Time.now();
    let hour : Int = 60 * 60 * 1_000_000_000;
    let day : Int = 24 * hour;
    let sail = addServiceRaw("Harbor Day Sail", 180, 24000, null);
    let ev = addServiceRaw("City EV Rental", 1440, 8900, null);
    let studio = addServiceRaw("Recording Studio Session", 60, 5000, null);
    ignore createSlotsRaw(sail, now + hour, now + 3 * day, 240); // every 4h for 3 days
    ignore createSlotsRaw(ev, now + hour, now + 3 * day, 720); // every 12h
    ignore createSlotsRaw(studio, now + hour, now + day, 60); // hourly for a day
    true;
  };

  // ── Frontend view-models (flat records — easy to decode in the SPA) ──
  // A "service" here is any reservable LISTING — a boat, a car, a studio, an
  // appointment. These flatten the photo opt → "" and join the listing name onto
  // bookings so each page needs one call.

  public query func servicesView() : async [{ id : Nat; name : Text; durationMinutes : Nat; priceCents : Nat; photoPath : Text }] {
    Array.map<Service, { id : Nat; name : Text; durationMinutes : Nat; priceCents : Nat; photoPath : Text }>(
      Iter.toArray(Map.values(services)),
      func(s) { { id = s.id; name = s.name; durationMinutes = s.durationMinutes; priceCents = s.priceCents; photoPath = (switch (s.photoPath) { case (?p) p; case null "" }) } },
    )
  };

  public query func availableSlotsView(serviceId : Nat) : async [{ id : Nat; serviceId : Nat; startNs : Int }] {
    let now = Time.now();
    let free = Array.filter(Iter.toArray(Map.values(slots)), func(s : Slot) : Bool {
      s.serviceId == serviceId and s.booked == null and s.startNs >= now;
    });
    let sorted = Array.sort(free, func(a : Slot, b : Slot) : { #less; #equal; #greater } { Int.compare(a.startNs, b.startNs) });
    Array.map<Slot, { id : Nat; serviceId : Nat; startNs : Int }>(sorted, func(s) { { id = s.id; serviceId = s.serviceId; startNs = s.startNs } })
  };

  public shared query(msg) func myBookingsView() : async [{ id : Nat; serviceId : Nat; serviceName : Text; slotStart : Int }] {
    let now = Time.now();
    let myIds = switch (Map.get(customerBookings, Principal.compare, msg.caller)) { case (?ids) ids; case null { return [] } };
    let rows = Array.map<Nat, { id : Nat; serviceId : Nat; serviceName : Text; slotStart : Int }>(myIds, func(id) {
      switch (Map.get(bookings, Nat.compare, id)) {
        case (?b) {
          let nm = switch (Map.get(services, Nat.compare, b.serviceId)) { case (?s) s.name; case null "(removed)" };
          { id = b.id; serviceId = b.serviceId; serviceName = nm; slotStart = b.slotStart }
        };
        case null { { id; serviceId = 0; serviceName = "(missing)"; slotStart = 0 } };
      }
    });
    let upcoming = Array.filter(rows, func(r : { id : Nat; serviceId : Nat; serviceName : Text; slotStart : Int }) : Bool { r.slotStart >= now });
    Array.sort(upcoming, func(a, b) : { #less; #equal; #greater } { Int.compare(a.slotStart, b.slotStart) })
  };
}
